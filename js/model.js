/* Gulf of Khambhat hydrodynamic + contaminant model
 *
 * 2D depth-averaged shallow-water equations on an Arakawa C-grid
 *   - forward-backward time stepping, semi-implicit quadratic bottom friction
 *   - Coriolis, optional nonlinear momentum advection (creates tidal residual eddies)
 *   - horizontal eddy viscosity, wind stress from real 10 m wind
 *   - wetting & drying of tidal flats (upwind flux depth + positivity limiter)
 *   - open boundary (south & west edges) clamped to real sea level from Open-Meteo
 * Eulerian tracers (finite-volume, donor cell): toxic (conservative), organic (first-order decay), water age.
 * Lagrangian particles: drifters (with trails), plume particles, oil (with 3 % windage).
 */
(function () {
  'use strict';
  const G = 9.81, RHO = 1025, RHO_AIR = 1.22, CD_WIND = 1.3e-3;
  const HDRY = 0.10;          // m: thinner water films count as dry
  const LAND_LEVEL = 1.0;     // m above MSL: higher ground never floods
  const M2 = 12.4206 * 3600;  // principal lunar semidiurnal period (s)
  const RES_WINDOW = 2 * M2;  // averaging window for residual (tide-averaged) currents
  const DAY = 86400;

  const KIND_DRIFTER = 0, KIND_PLUME = 1, KIND_OIL = 2;

  class GulfModel {
    constructor(data) {
      const g = data.grid;
      const nx = (this.nx = g.nx), ny = (this.ny = g.ny), N = (this.N = nx * ny);
      this.lon0 = g.lon0; this.lat0 = g.lat0; this.d = g.d;
      this.elev = Float32Array.from(g.elev);
      this.dy = g.d * 110574;
      this.dxRow = new Float32Array(ny);
      this.fRow = new Float32Array(ny);
      for (let j = 0; j < ny; j++) {
        const lat = ((g.lat0 + j * g.d) * Math.PI) / 180;
        this.dxRow[j] = g.d * 111320 * Math.cos(lat);
        this.fRow[j] = 2 * 7.2921e-5 * Math.sin(lat);
      }
      this.h = new Float32Array(N);
      this.mask = new Uint8Array(N);
      this.isBnd = new Uint8Array(N);
      this.buildMask();

      this.eta = new Float32Array(N);
      this.Hold = new Float32Array(N);
      this.u = new Float32Array(N); this.un = new Float32Array(N);
      this.v = new Float32Array(N); this.vn = new Float32Array(N);
      this.Fu = new Float32Array(N); this.Fv = new Float32Array(N);
      this.lim = new Float32Array(N);
      this.toxic = new Float32Array(N); this.organic = new Float32Array(N); this.age = new Float32Array(N);
      this.tmp = new Float32Array(N);
      this.su = new Float32Array(N); this.sv = new Float32Array(N);
      this.ru = new Float32Array(N); this.rv = new Float32Array(N);
      this.resTime = 0; this.hasResidual = false;

      let hmax = 0;
      for (const k of this.cells) hmax = Math.max(hmax, this.h[k]);
      this.hmax = hmax;
      const dxMin = Math.min(...this.dxRow, this.dy);
      this.dt = Math.min(60, Math.floor((0.45 * dxMin) / Math.sqrt(G * (hmax + 6))));

      this.params = {
        ampScale: 1, friction: 0.0012, advection: true, wind: true, windScale: 1,
        Ah: 10, organicHalfLife: 2, oilHalfLife: 4, drifterDiff: 5,
      };
      this.industries = [];
      this.particles = new Particles(12000);
      this.drifterTrails = new Map(); // particle id -> [gx,gy,...]
      this.stats = { emittedToxic: 0, emittedOrganic: 0, decayed: 0, flushedToxic: 0, flushedOrganic: 0 };
      this.setForcing(data);
      this.reset(0, false);
    }

    /* ---------- geometry ---------- */
    buildMask() {
      const { nx, ny, N, elev, h, mask, isBnd } = this;
      const cand = new Uint8Array(N);
      for (let k = 0; k < N; k++) cand[k] = elev[k] < LAND_LEVEL ? 1 : 0;
      // keep only water connected to the open sea on the south / west edges
      const stack = [];
      for (let i = 0; i < nx; i++) if (elev[i] < -5) stack.push(i);
      for (let j = 0; j < ny; j++) if (elev[j * nx] < -5) stack.push(j * nx);
      for (const k of stack) mask[k] = 1;
      while (stack.length) {
        const k = stack.pop(), i = k % nx, j = (k / nx) | 0;
        const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
        for (const m of nb) if (m >= 0 && cand[m] && !mask[m]) { mask[m] = 1; stack.push(m); }
      }
      const cells = [], ufaces = [], vfaces = [], interior = [];
      for (let k = 0; k < N; k++) {
        if (!mask[k]) continue;
        const i = k % nx, j = (k / nx) | 0;
        h[k] = -elev[k];
        cells.push(k);
        if (i === 0 || j === 0) isBnd[k] = 1; else interior.push(k);
        if (i < nx - 1 && mask[k + 1]) ufaces.push(k);
        if (j < ny - 1 && mask[k + nx]) vfaces.push(k);
      }
      this.cells = Int32Array.from(cells);
      this.interior = Int32Array.from(interior);
      this.ufaces = Int32Array.from(ufaces);
      this.vfaces = Int32Array.from(vfaces);
      this.bndCells = Int32Array.from(cells.filter((k) => isBnd[k]));
    }

    cellOf(lon, lat) {
      const i = Math.round((lon - this.lon0) / this.d), j = Math.round((lat - this.lat0) / this.d);
      if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
      return j * this.nx + i;
    }
    lonlatOfCell(k) { return [this.lon0 + (k % this.nx) * this.d, this.lat0 + ((k / this.nx) | 0) * this.d]; }

    /** nearest model water cell with at least minDepth still-water depth (for outfalls / stations) */
    nearestWet(lon, lat, minDepth = 2) {
      let best = -1, bd = Infinity;
      const gi = (lon - this.lon0) / this.d, gj = (lat - this.lat0) / this.d;
      for (const k of this.interior) {
        if (this.h[k] < minDepth) continue;
        const di = (k % this.nx) - gi, dj = ((k / this.nx) | 0) - gj;
        const dd = di * di * 0.87 + dj * dj;
        if (dd < bd) { bd = dd; best = k; }
      }
      return best;
    }

    /* ---------- forcing ---------- */
    setForcing(data) {
      this.data = data;
      this.time0 = Date.parse(data.time0);
      this.hours = data.hours;
      this.tEnd = (data.hours - 1) * 3600;
      const clean = (arr) => {
        const a = arr.slice();
        let last = null;
        for (let i = 0; i < a.length; i++) if (a[i] == null) a[i] = last; else last = a[i];
        last = null;
        for (let i = a.length - 1; i >= 0; i--) if (a[i] == null) a[i] = last; else last = a[i];
        const ok = a.filter((x) => x != null);
        const mean = ok.reduce((s, x) => s + x, 0) / Math.max(1, ok.length);
        return Float32Array.from(a.map((x) => (x == null ? 0 : x - mean)));
      };
      this.bPts = data.boundary.map((b) => ({ lat: b.lat, lon: b.lon, eta: clean(b.eta) }));
      // inverse-distance weights from each boundary cell to the forcing points
      const np = this.bPts.length;
      this.bW = new Float32Array(this.bndCells.length * np);
      this.bndCells.forEach((k, n) => {
        const [lon, lat] = this.lonlatOfCell(k);
        let s = 0;
        for (let p = 0; p < np; p++) {
          const dl = (this.bPts[p].lon - lon) * 0.93, dp = this.bPts[p].lat - lat;
          const w = 1 / Math.pow(dl * dl + dp * dp + 1e-4, 1.5);
          this.bW[n * np + p] = w; s += w;
        }
        for (let p = 0; p < np; p++) this.bW[n * np + p] /= s;
      });
      this.bVal = new Float32Array(np);
      this.stations = data.stations.map((s) => {
        const k = this.nearestWet(s.lon, s.lat, 1);
        return { ...s, k, etaObs: clean(s.eta), etaModel: new Float32Array(data.hours).fill(NaN) };
      });
      const W = data.wind;
      this.windU = Float32Array.from(W.speed.map((s, i) => -(s || 0) * Math.sin(((W.dir[i] || 0) * Math.PI) / 180)));
      this.windV = Float32Array.from(W.speed.map((s, i) => -(s || 0) * Math.cos(((W.dir[i] || 0) * Math.PI) / 180)));
      this.probeSeries = new Float32Array(data.hours).fill(NaN);
    }

    hourLerp(arr, t) {
      const x = Math.max(0, Math.min(this.hours - 1.001, t / 3600));
      const i = Math.floor(x), f = x - i;
      return arr[i] * (1 - f) + arr[i + 1] * f;
    }
    windAt(t) { return [this.hourLerp(this.windU, t), this.hourLerp(this.windV, t)]; }

    applyBoundary(t) {
      const np = this.bPts.length, ramp = Math.min(1, Math.max(0, (t - this.tRamp) / (4 * 3600)));
      for (let p = 0; p < np; p++) this.bVal[p] = this.hourLerp(this.bPts[p].eta, t) * this.params.ampScale * ramp;
      const { bndCells, bW, eta, h } = this;
      for (let n = 0; n < bndCells.length; n++) {
        let e = 0;
        for (let p = 0; p < np; p++) e += bW[n * np + p] * this.bVal[p];
        const k = bndCells[n];
        eta[k] = Math.max(e, -h[k]);
      }
    }

    /* ---------- state ---------- */
    /** restart hydrodynamics at time t (s since time0); spin-up starts `spin` seconds earlier */
    reset(t, keepTracers = true, spin = 18 * 3600) {
      const { eta, h } = this;
      for (const k of this.cells) eta[k] = Math.max(0, -h[k]);
      this.u.fill(0); this.v.fill(0); this.un.fill(0); this.vn.fill(0);
      if (!keepTracers) this.clearPollution();
      this.t = t - spin;
      this.tRamp = this.t;
      this.targetT = t;
      this.su.fill(0); this.sv.fill(0); this.resTime = 0; this.hasResidual = false;
    }
    get spinningUp() { return this.t < this.targetT; }

    clearPollution() {
      this.toxic.fill(0); this.organic.fill(0);
      this.particles.clear(KIND_PLUME); this.particles.clear(KIND_OIL);
      for (const k in this.stats) this.stats[k] = 0;
      this.probeSeries.fill(NaN);
    }
    clearDrifters() { this.particles.clear(KIND_DRIFTER); this.drifterTrails.clear(); }

    /* ---------- one time step ---------- */
    step() {
      const dt = this.dt, P = this.params;
      const { nx, eta, h, u, v, un, vn, Fu, Fv, dy, dxRow, fRow } = this;
      const tracers = !this.spinningUp;
      const tNew = this.t + dt;
      const Ah = P.Ah, cd = P.friction;
      let tx = 0, ty = 0;
      if (P.wind) {
        const [wu, wv] = this.windAt(this.t);
        const ws = Math.hypot(wu, wv) * P.windScale;
        tx = (RHO_AIR * CD_WIND * ws * wu * P.windScale) / RHO;
        ty = (RHO_AIR * CD_WIND * ws * wv * P.windScale) / RHO;
      }
      const adv = P.advection;

      // --- u momentum
      const uf = this.ufaces;
      for (let n = 0; n < uf.length; n++) {
        const k = uf[n], a = k, b = k + 1, j = (k / nx) | 0;
        const Hm = Math.max(eta[a], eta[b]) + Math.min(h[a], h[b]);
        if (Hm < HDRY) { un[k] = 0; continue; }
        const dx = dxRow[j], uu = u[k];
        const vS0 = j > 0 ? v[a - nx] : 0, vS1 = j > 0 ? v[b - nx] : 0;
        const vb = 0.25 * (v[a] + v[b] + vS0 + vS1);
        const uW = u[k - 1] || 0, uE = u[k + 1] || 0;
        const uS = j > 0 ? u[k - nx] : uu, uN = u[k + nx] || 0;
        let acc = (-G * (eta[b] - eta[a])) / dx + fRow[j] * vb;
        if (adv) {
          const dudx = uu > 0 ? (uu - uW) / dx : (uE - uu) / dx;
          const dudy = vb > 0 ? (uu - uS) / dy : (uN - uu) / dy;
          acc -= uu * dudx + vb * dudy;
        }
        acc += Ah * ((uW + uE - 2 * uu) / (dx * dx) + (uS + uN - 2 * uu) / (dy * dy));
        acc += tx / Math.max(Hm, 1);
        const spd = Math.sqrt(uu * uu + vb * vb);
        let nu = (uu + dt * acc) / (1 + (dt * cd * spd) / Hm);
        un[k] = nu > 5 ? 5 : nu < -5 ? -5 : nu;
      }
      // --- v momentum (uses new u for Coriolis)
      const vf = this.vfaces;
      for (let n = 0; n < vf.length; n++) {
        const k = vf[n], a = k, b = k + nx, j = (k / nx) | 0;
        const Hm = Math.max(eta[a], eta[b]) + Math.min(h[a], h[b]);
        if (Hm < HDRY) { vn[k] = 0; continue; }
        const dx = 0.5 * (dxRow[j] + dxRow[j + 1]), vv = v[k];
        const ub = 0.25 * (un[a] + un[b] + (un[a - 1] || 0) + (un[b - 1] || 0));
        const vS = j > 0 ? v[k - nx] : vv, vN = v[k + nx] || 0;
        const vW = v[k - 1] || 0, vE = v[k + 1] || 0;
        let acc = (-G * (eta[b] - eta[a])) / dy - fRow[j] * ub;
        if (adv) {
          const dvdx = ub > 0 ? (vv - vW) / dx : (vE - vv) / dx;
          const dvdy = vv > 0 ? (vv - vS) / dy : (vN - vv) / dy;
          acc -= ub * dvdx + vv * dvdy;
        }
        acc += Ah * ((vW + vE - 2 * vv) / (dx * dx) + (vS + vN - 2 * vv) / (dy * dy));
        acc += ty / Math.max(Hm, 1);
        const spd = Math.sqrt(vv * vv + ub * ub);
        let nv = (vv + dt * acc) / (1 + (dt * cd * spd) / Hm);
        vn[k] = nv > 5 ? 5 : nv < -5 ? -5 : nv;
      }
      this.u = un; this.un = u; this.v = vn; this.vn = v;
      const U = this.u, V = this.v;

      // --- volume fluxes with upwind depth, then positivity limiter
      const Hold = this.Hold, lim = this.lim;
      for (const k of this.cells) { Hold[k] = eta[k] + h[k]; lim[k] = 0; }
      for (let n = 0; n < uf.length; n++) {
        const k = uf[n], uu = U[k];
        const f = uu * (uu > 0 ? Hold[k] : Hold[k + 1]) * dy;
        Fu[k] = f;
        if (f > 0) lim[k] += f; else lim[k + 1] -= f;
      }
      for (let n = 0; n < vf.length; n++) {
        const k = vf[n], j = (k / nx) | 0, vv = V[k];
        const f = vv * (vv > 0 ? Hold[k] : Hold[k + nx]) * 0.5 * (dxRow[j] + dxRow[j + 1]);
        Fv[k] = f;
        if (f > 0) lim[k] += f; else lim[k + nx] -= f;
      }
      for (const k of this.cells) {
        const out = lim[k] * dt, vol = Hold[k] * dxRow[(k / nx) | 0] * dy;
        lim[k] = out > 0.8 * vol ? (0.8 * vol) / out : 1;
      }
      for (let n = 0; n < uf.length; n++) { const k = uf[n]; Fu[k] *= Fu[k] > 0 ? lim[k] : lim[k + 1]; }
      for (let n = 0; n < vf.length; n++) { const k = vf[n]; Fv[k] *= Fv[k] > 0 ? lim[k] : lim[k + nx]; }

      // --- continuity
      const inr = this.interior;
      for (let n = 0; n < inr.length; n++) {
        const k = inr[n], area = dxRow[(k / nx) | 0] * dy;
        const div = Fu[k] - Fu[k - 1] + Fv[k] - Fv[k - nx];
        let e = eta[k] - (dt * div) / area;
        if (e < -h[k]) e = -h[k];
        eta[k] = e;
      }
      this.applyBoundary(tNew);

      // --- residual (tide-averaged) currents, accumulated only after spin-up
      if (tracers) {
      for (let n = 0; n < uf.length; n++) this.su[uf[n]] += U[uf[n]] * dt;
      for (let n = 0; n < vf.length; n++) this.sv[vf[n]] += V[vf[n]] * dt;
      this.resTime += dt;
      if (this.resTime >= RES_WINDOW) {
        for (let k = 0; k < this.N; k++) { this.ru[k] = this.su[k] / this.resTime; this.rv[k] = this.sv[k] / this.resTime; }
        this.su.fill(0); this.sv.fill(0); this.resTime = 0; this.hasResidual = true;
      }
      }

      if (tracers) {
        this.advectTracer(this.toxic, 'flushedToxic');
        this.advectTracer(this.organic, 'flushedOrganic');
        this.advectTracer(this.age, null);
        const kdec = 1 - Math.exp((-Math.LN2 * dt) / (P.organicHalfLife * DAY));
        let dec = 0;
        for (let n = 0; n < inr.length; n++) {
          const k = inr[n], H = eta[k] + h[k];
          const d = this.organic[k] * kdec;
          dec += d * H * dxRow[(k / nx) | 0] * dy;
          this.organic[k] -= d;
          if (H > HDRY) this.age[k] += dt / DAY;
        }
        this.stats.decayed += dec;
        for (const k of this.bndCells) this.age[k] = 0;
        this.emit(dt);
      }
      this.t = tNew;
      this.stepCount = (this.stepCount || 0) + 1;
      if (this.stepCount % 3 === 0) this.moveParticles(3 * dt);
      this.record();
    }

    /** donor-cell finite-volume transport of concentration C using this step's fluxes */
    advectTracer(C, flushKey) {
      const { nx, dt, Fu, Fv, eta, h, Hold, dxRow, dy } = this;
      const out = this.tmp;
      const inr = this.interior;
      for (let n = 0; n < inr.length; n++) {
        const k = inr[n];
        const fE = Fu[k], fW = Fu[k - 1], fN = Fv[k], fS = Fv[k - nx];
        let net = 0;
        if (fE !== 0) net += fE > 0 ? fE * C[k] : fE * C[k + 1];
        if (fW !== 0) net -= fW > 0 ? fW * C[k - 1] : fW * C[k];
        if (fN !== 0) net += fN > 0 ? fN * C[k] : fN * C[k + nx];
        if (fS !== 0) net -= fS > 0 ? fS * C[k - nx] : fS * C[k];
        const area = dxRow[(k / nx) | 0] * dy;
        const Vn = (eta[k] + h[k]) * area;
        const M = C[k] * Hold[k] * area - dt * net;
        out[k] = Vn > 0.02 * area ? Math.max(0, M / Vn) : C[k];
      }
      let flushed = 0;
      if (flushKey) {
        // mass leaving the interior into the open-boundary ring is lost to the Arabian Sea
        for (const k of this.bndCells) {
          const i = k % nx, j = (k / nx) | 0;
          if (i < nx - 1 && !this.isBnd[k + 1] && this.mask[k + 1] && Fu[k] < 0) flushed -= Fu[k] * C[k + 1];
          if (j < this.ny - 1 && !this.isBnd[k + nx] && this.mask[k + nx] && Fv[k] < 0) flushed -= Fv[k] * C[k + nx];
        }
        this.stats[flushKey] += flushed * dt;
      }
      for (let n = 0; n < inr.length; n++) C[inr[n]] = out[inr[n]];
      for (const k of this.bndCells) C[k] = 0;
    }

    /* ---------- industries ---------- */
    addIndustry(ind) {
      ind.k = this.nearestWet(ind.lon, ind.lat, 2);
      ind.id = ind.id || 'ind' + Math.random().toString(36).slice(2, 8);
      ind.etaPrev = 0; ind.emitAcc = 0;
      this.industries.push(ind);
      return ind;
    }
    moveIndustry(ind, lon, lat) { ind.lon = lon; ind.lat = lat; ind.k = this.nearestWet(lon, lat, 2); }
    removeIndustry(id) { this.industries = this.industries.filter((i) => i.id !== id); }

    /** instantaneous spill of `tonnes` of the industry's pollutant mix at lon/lat */
    spill(lon, lat, tonnes, mix) {
      const k0 = this.nearestWet(lon, lat, 1);
      if (k0 < 0) return;
      const grams = tonnes * 1e6, cellsHit = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const k = k0 + dj * this.nx + di;
        if (this.mask[k] && !this.isBnd[k] && this.eta[k] + this.h[k] > 0.5) cellsHit.push(k);
      }
      for (const k of cellsHit) {
        const V = (this.eta[k] + this.h[k]) * this.dxRow[(k / this.nx) | 0] * this.dy;
        const m = grams / cellsHit.length;
        this.toxic[k] += (m * mix.toxic) / V;
        this.organic[k] += (m * mix.organic) / V;
      }
      this.stats.emittedToxic += grams * mix.toxic;
      this.stats.emittedOrganic += grams * mix.organic;
      const [gx, gy] = [k0 % this.nx, (k0 / this.nx) | 0];
      const np = Math.round(150 * Math.min(4, Math.sqrt(tonnes / 10)));
      for (let n = 0; n < np; n++) {
        const kind = mix.oil > 0 && Math.random() < mix.oil * 2 ? KIND_OIL : KIND_PLUME;
        this.particles.add(gx + (Math.random() - 0.5) * 1.5, gy + (Math.random() - 0.5) * 1.5, kind, 0, mix.color);
      }
    }

    emit(dt) {
      const { eta, h, dxRow, dy, nx } = this;
      for (const ind of this.industries) {
        const k = ind.k;
        if (k < 0 || !ind.on) continue;
        const e = eta[k];
        const falling = e < ind.etaPrev;
        ind.etaPrev = e;
        if (ind.mode === 'ebb' && !falling) continue;
        if (ind.mode === 'flood' && falling) continue;
        const H = e + h[k];
        if (H < 0.5) continue;
        const V = H * dxRow[(k / nx) | 0] * dy;
        const gps = (ind.rate * 1000) / DAY * (ind.mode === 'continuous' ? 1 : 2); // kg/day -> g/s
        const m = gps * dt;
        this.toxic[k] += (m * ind.mix.toxic) / V;
        this.organic[k] += (m * ind.mix.organic) / V;
        this.stats.emittedToxic += m * ind.mix.toxic;
        this.stats.emittedOrganic += m * ind.mix.organic;
        // visual particles: ~1 per hour per 3000 kg/day
        ind.emitAcc += (dt / 3600) * Math.max(0.5, ind.rate / 3000);
        while (ind.emitAcc >= 1) {
          ind.emitAcc -= 1;
          const gx = (k % nx) + (Math.random() - 0.5) * 0.6, gy = ((k / nx) | 0) + (Math.random() - 0.5) * 0.6;
          const kind = Math.random() < ind.mix.oil ? KIND_OIL : KIND_PLUME;
          this.particles.add(gx, gy, kind, 0, ind.mix.color);
        }
      }
    }

    /* ---------- Lagrangian particles ---------- */
    sampleU(gx, gy, U) {
      const nx = this.nx, fx = gx - 0.5, i0 = Math.floor(fx), j0 = Math.floor(gy), tx = fx - i0, ty = gy - j0;
      if (i0 < 0 || j0 < 0 || i0 >= nx - 1 || j0 >= this.ny - 1) return 0;
      const k = j0 * nx + i0;
      return (U[k] * (1 - tx) + U[k + 1] * tx) * (1 - ty) + (U[k + nx] * (1 - tx) + U[k + nx + 1] * tx) * ty;
    }
    sampleV(gx, gy, V) {
      const nx = this.nx, fy = gy - 0.5, i0 = Math.floor(gx), j0 = Math.floor(fy), tx = gx - i0, ty = fy - j0;
      if (i0 < 0 || j0 < 0 || i0 >= nx - 1 || j0 >= this.ny - 1) return 0;
      const k = j0 * nx + i0;
      return (V[k] * (1 - tx) + V[k + 1] * tx) * (1 - ty) + (V[k + nx] * (1 - tx) + V[k + nx + 1] * tx) * ty;
    }
    /** velocity in grid cells per second at a grid position */
    velCells(gx, gy, U, V) {
      const j = Math.max(0, Math.min(this.ny - 1, Math.round(gy)));
      return [this.sampleU(gx, gy, U) / this.dxRow[j], this.sampleV(gx, gy, V) / this.dy];
    }
    isWetAt(gx, gy) {
      const i = Math.round(gx), j = Math.round(gy);
      if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return false;
      const k = j * this.nx + i;
      return this.mask[k] && this.eta[k] + this.h[k] > HDRY;
    }

    moveParticles(dt) {
      const p = this.particles, P = this.params, U = this.u, V = this.v;
      const [wu, wv] = P.wind ? this.windAt(this.t) : [0, 0];
      const oilKill = 1 - Math.exp((-Math.LN2 * dt) / (P.oilHalfLife * DAY));
      const plumeKill = dt / (12 * DAY);
      const sd = Math.sqrt(2 * P.drifterDiff * dt);
      for (let n = 0; n < p.count; n++) {
        if (!p.alive[n]) continue;
        const kind = p.kind[n];
        if (kind === KIND_OIL && Math.random() < oilKill) { p.alive[n] = 0; continue; }
        if (kind === KIND_PLUME && Math.random() < plumeKill) { p.alive[n] = 0; continue; }
        const x = p.x[n], y = p.y[n];
        const [u1, v1] = this.velCells(x, y, U, V);
        const xm = x + 0.5 * dt * u1, ym = y + 0.5 * dt * v1;
        let [u2, v2] = this.velCells(xm, ym, U, V);
        const j = Math.max(0, Math.min(this.ny - 1, Math.round(y)));
        if (kind === KIND_OIL) { u2 += (0.03 * wu * P.windScale) / this.dxRow[j]; v2 += (0.03 * wv * P.windScale) / this.dy; }
        const nxp = x + dt * u2 + (gauss() * sd) / this.dxRow[j];
        const nyp = y + dt * v2 + (gauss() * sd) / this.dy;
        if (this.isWetAt(nxp, nyp)) { p.x[n] = nxp; p.y[n] = nyp; }
        p.age[n] += dt;
        const ii = Math.round(p.x[n]), jj = Math.round(p.y[n]);
        if (ii <= 0 || jj <= 0) { p.alive[n] = 0; p.exited[n] = 1; continue; } // left through the open boundary
      }
      p.compact();
    }

    addDrifters(gx, gy, count = 12, spread = 0.8) {
      const ids = [];
      const group = (this.drifterGroup = (this.drifterGroup || 0) + 1);
      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2, r = count > 1 ? spread * Math.sqrt((n % 4 + 1) / 4) : 0;
        const x = gx + Math.cos(a) * r, y = gy + Math.sin(a) * r;
        if (!this.isWetAt(x, y)) continue;
        const id = this.particles.add(x, y, KIND_DRIFTER, group);
        this.drifterTrails.set(id, { pts: [x, y], group, born: this.t });
        ids.push(id);
      }
      return ids;
    }
    /** seed drifters over the whole gulf on a regular lattice */
    seedDrifterGrid(spacing = 6) {
      for (let j = 2; j < this.ny; j += spacing) for (let i = 2; i < this.nx; i += spacing) {
        const k = j * this.nx + i;
        if (this.mask[k] && !this.isBnd[k] && this.h[k] > 3 && this.lonlatOfCell(k)[1] > 20.75) this.addDrifters(i, j, 1, 0);
      }
    }

    /* ---------- bookkeeping ---------- */
    record() {
      const hr = Math.round(this.t / 3600);
      if (Math.abs(this.t - hr * 3600) >= this.dt / 2 || hr < 0 || hr >= this.hours) return;
      for (const s of this.stations) if (s.k >= 0) s.etaModel[hr] = this.eta[s.k];
      if (this.probeK >= 0 && !this.spinningUp) this.probeSeries[hr] = this.toxic[this.probeK] + this.organic[this.probeK];
      // drifter trails: one point per hour
      const p = this.particles;
      for (let n = 0; n < p.count; n++) {
        if (p.kind[n] !== KIND_DRIFTER) continue;
        const tr = this.drifterTrails.get(p.id[n]);
        if (tr && tr.pts.length < 2 * 24 * 40) tr.pts.push(p.x[n], p.y[n]);
      }
    }
    setProbe(k) { this.probeK = k; this.probeSeries.fill(NaN); }

    summary() {
      const { nx, eta, h, dxRow, dy } = this;
      let mt = 0, mo = 0, area1 = 0, wetArea = 0, cmax = 0, ageSum = 0, volSum = 0;
      for (const k of this.interior) {
        const H = eta[k] + h[k];
        if (H < HDRY) continue;
        const a = dxRow[(k / nx) | 0] * dy, V = H * a;
        const c = this.toxic[k] + this.organic[k];
        mt += this.toxic[k] * V; mo += this.organic[k] * V;
        wetArea += a; if (c > 0.01) area1 += a;
        if (c > cmax) cmax = c;
        ageSum += this.age[k] * V; volSum += V;
      }
      return { massToxic: mt, massOrganic: mo, pollutedArea: area1 / 1e6, wetArea: wetArea / 1e6, cmax, meanAge: ageSum / volSum, volume: volSum };
    }
  }

  /* struct-of-arrays particle store */
  class Particles {
    constructor(cap) {
      this.cap = cap; this.count = 0; this.nextId = 1;
      this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.age = new Float32Array(cap);
      this.kind = new Uint8Array(cap); this.alive = new Uint8Array(cap); this.exited = new Uint8Array(cap);
      this.group = new Int32Array(cap); this.id = new Int32Array(cap); this.color = new Array(cap);
    }
    add(x, y, kind, group = 0, color = null) {
      if (this.count >= this.cap) this.dropOldest(kind === 0 ? 1 : kind); // never evict drifters for plume particles
      if (this.count >= this.cap && kind === 0) this.dropOldest(2);
      if (this.count >= this.cap) return -1;
      const n = this.count++;
      this.x[n] = x; this.y[n] = y; this.kind[n] = kind; this.alive[n] = 1; this.exited[n] = 0;
      this.age[n] = 0; this.group[n] = group; this.color[n] = color; this.id[n] = this.nextId++;
      return this.id[n];
    }
    dropOldest(kind) {
      let best = -1, ba = -1;
      for (let n = 0; n < this.count; n++) if (this.kind[n] === kind && this.age[n] > ba) { ba = this.age[n]; best = n; }
      if (best >= 0) { this.alive[best] = 0; this.compact(); }
    }
    clear(kind) { for (let n = 0; n < this.count; n++) if (this.kind[n] === kind) this.alive[n] = 0; this.compact(); }
    countKind(kind) { let c = 0; for (let n = 0; n < this.count; n++) if (this.kind[n] === kind) c++; return c; }
    compact() {
      let m = 0;
      for (let n = 0; n < this.count; n++) {
        if (!this.alive[n]) continue;
        if (m !== n) {
          this.x[m] = this.x[n]; this.y[m] = this.y[n]; this.age[m] = this.age[n]; this.kind[m] = this.kind[n];
          this.alive[m] = 1; this.exited[m] = this.exited[n]; this.group[m] = this.group[n]; this.id[m] = this.id[n]; this.color[m] = this.color[n];
        }
        m++;
      }
      this.count = m;
    }
  }

  let spare = null;
  function gauss() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let a, b, r;
    do { a = Math.random() * 2 - 1; b = Math.random() * 2 - 1; r = a * a + b * b; } while (r >= 1 || r === 0);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    spare = b * f; return a * f;
  }

  window.GulfModel = GulfModel;
  window.GulfModel.KIND = { DRIFTER: KIND_DRIFTER, PLUME: KIND_PLUME, OIL: KIND_OIL };
  window.GulfModel.HDRY = HDRY;
})();
