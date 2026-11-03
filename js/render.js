/* Map renderer for the Gulf of Khambhat simulator (canvas 2D, no libraries).
 *
 *   const r = new MapRenderer(canvas, model);
 *   r.resize(); r.draw(ui); r.zoomAt(sx, sy, f); r.panBy(dx, dy); r.fit();
 *   r.screenToGrid(sx, sy) / r.gridToScreen(gx, gy)    (CSS px relative to canvas <-> grid coords)
 *   r.hitIndustry(sx, sy) / r.hitStation(sx, sy) / r.legend() / r.invalidateTrails()
 *   extras: r.setModel(model) (rebuilds the static layers), r.rebuildBase()
 *
 * Layer order: background, base water (depth + relief), field overlay (wet cells only, tidal-flat
 * drying shown as mud), land (hillshaded, drawn on top so the overlay never bleeds onto land),
 * isobaths / coastline vectors, graticule, arrows, flow streaks (faded trail canvas), drifter trails,
 * plume + oil particles, industries, stations, city labels, probe / hover / placing ghost,
 * graticule labels, scale bar, north arrow.
 */
(function () {
  'use strict';

  const BASE_RES = 6;              // base-map pixels per grid cell
  const ZOOM_MIN = 0.5, ZOOM_MAX = 12;
  const STREAK_CAP = 4000;
  const PX_PER_MPS = 1.5;          // flow streak speed: CSS px per frame per m/s
  const RESIDUAL_BOOST = 8;
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

  const CITIES = [
    ['Bhavnagar', 21.76, 72.15], ['Ghogha', 21.68, 72.28], ['Alang', 21.40, 72.18], ['Talaja', 21.35, 72.04],
    ['Mahuva', 21.09, 71.76], ['Pipavav', 20.92, 71.51], ['Diu', 20.71, 70.98], ['Dholera', 22.25, 72.19],
    ['Khambhat', 22.31, 72.62], ['Jambusar', 22.05, 72.80], ['Dahej', 21.71, 72.58], ['Bharuch', 21.70, 72.98],
    ['Hazira', 21.12, 72.65], ['Surat', 21.17, 72.83], ['Navsari', 20.95, 72.92], ['Valsad', 20.61, 72.93],
    ['Daman', 20.41, 72.83],
  ];
  const GROUP_COLORS = ['#ffd166', '#06d6a0', '#ff6b8b', '#4cc9f0', '#f8961e', '#b5e48c', '#c77dff', '#f1faee', '#90e0ef', '#ffadad'];
  const PLACE_ICONS = { industry: '🏭', factory: '🏭', spill: '🛢️', oil: '🛢️', drifter: '🛟', drifters: '🛟', probe: '📍' };
  const LAND_STOPS = [
    [0.5, [116, 106, 80]], [4, [126, 116, 88]], [15, [110, 110, 80]], [50, [94, 100, 71]],
    [150, [104, 98, 75]], [500, [128, 116, 97]],
  ];
  const MUD = [100, 90, 68], MUD_A = 215;
  const STREAK_ALPHA = [0.3, 0.5, 0.72, 0.95];

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  }

  function landColor(e, out) {
    const S = LAND_STOPS;
    if (e <= S[0][0]) { out[0] = S[0][1][0]; out[1] = S[0][1][1]; out[2] = S[0][1][2]; return; }
    for (let i = 1; i < S.length; i++) {
      if (e <= S[i][0] || i === S.length - 1) {
        const a = S[i - 1], b = S[i], f = clamp((e - a[0]) / (b[0] - a[0]), 0, 1);
        out[0] = a[1][0] + (b[1][0] - a[1][0]) * f;
        out[1] = a[1][1] + (b[1][1] - a[1][1]) * f;
        out[2] = a[1][2] + (b[1][2] - a[1][2]) * f;
        return;
      }
    }
  }

  /** marching squares on the cell-centred field `f` at `level`; returns segments [x1,y1,x2,y2,...] in grid coords */
  function contour(f, nx, ny, level) {
    const segs = [];
    const px = [0, 0, 0, 0], py = [0, 0, 0, 0], has = [false, false, false, false];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        const v00 = f[k], v10 = f[k + 1], v01 = f[k + nx], v11 = f[k + nx + 1];
        const b00 = v00 >= level, b10 = v10 >= level, b01 = v01 >= level, b11 = v11 >= level;
        if (b00 === b10 && b00 === b01 && b00 === b11) continue;
        let n = 0;
        has[0] = b00 !== b10; if (has[0]) { px[0] = i + (level - v00) / (v10 - v00); py[0] = j; n++; }
        has[1] = b10 !== b11; if (has[1]) { px[1] = i + 1; py[1] = j + (level - v10) / (v11 - v10); n++; }
        has[2] = b01 !== b11; if (has[2]) { px[2] = i + (level - v01) / (v11 - v01); py[2] = j + 1; n++; }
        has[3] = b00 !== b01; if (has[3]) { px[3] = i; py[3] = j + (level - v00) / (v01 - v00); n++; }
        if (n === 2) {
          let a = -1, b = -1;
          for (let e = 0; e < 4; e++) if (has[e]) { if (a < 0) a = e; else b = e; }
          segs.push(px[a], py[a], px[b], py[b]);
        } else if (n === 4) {
          const mid = (v00 + v10 + v01 + v11) / 4 >= level;
          if (mid === b00) { segs.push(px[0], py[0], px[1], py[1], px[2], py[2], px[3], py[3]); }
          else { segs.push(px[3], py[3], px[0], py[0], px[1], py[1], px[2], py[2]); }
        }
      }
    }
    return Float32Array.from(segs);
  }

  /* bilinear face-velocity samplers (same staggering as GulfModel.sampleU/V, allocation-free) */
  function sampleU(m, U, gx, gy) {
    const nx = m.nx, fx = gx - 0.5, i0 = Math.floor(fx), j0 = Math.floor(gy), tx = fx - i0, ty = gy - j0;
    if (i0 < 0 || j0 < 0 || i0 >= nx - 1 || j0 >= m.ny - 1) return 0;
    const k = j0 * nx + i0;
    return (U[k] * (1 - tx) + U[k + 1] * tx) * (1 - ty) + (U[k + nx] * (1 - tx) + U[k + nx + 1] * tx) * ty;
  }
  function sampleV(m, V, gx, gy) {
    const nx = m.nx, fy = gy - 0.5, i0 = Math.floor(gx), j0 = Math.floor(fy), tx = gx - i0, ty = fy - j0;
    if (i0 < 0 || j0 < 0 || i0 >= nx - 1 || j0 >= m.ny - 1) return 0;
    const k = j0 * nx + i0;
    return (V[k] * (1 - tx) + V[k + 1] * tx) * (1 - ty) + (V[k + nx] * (1 - tx) + V[k + nx + 1] * tx) * ty;
  }

  function haloText(ctx, text, x, y) {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  class MapRenderer {
    constructor(canvas, model) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.layer = 'speed';
      this.show = { particles: true, arrows: false, residualArrows: false, drifters: true, plume: true, labels: true, stations: true, industries: true };
      this.flowSource = 'instant';
      this.dpr = 1; this.W = 1; this.H = 1;
      this.kx = 1; this.ox = 0; this.oy = 0; this.fitK = 1; this.userView = false;
      this.frame = 0;

      this.trailCanvas = mkCanvas(1, 1);
      this.trailCtx = this.trailCanvas.getContext('2d');
      this.trailsDirty = true;
      this.sx = new Float32Array(STREAK_CAP);
      this.sy = new Float32Array(STREAK_CAP);
      this.slife = new Float32Array(STREAK_CAP);
      this.nStreak = 3000;
      this.segBuf = [0, 1, 2, 3].map(() => new Float32Array(STREAK_CAP * 4));
      this.segN = new Int32Array(4);
      this._colors = [];
      this._boxes = [];
      this._rgb = [0, 0, 0];

      this.setModel(model);
      this.resize();
    }

    /* ---------- static layers ---------- */
    setModel(model) {
      this.model = model;
      const m = model, N = m.N, jm = m.ny >> 1;
      this.aspect = m.dy / m.dxRow[jm];
      this.dxMid = m.dxRow[jm];
      this.ovCanvas = mkCanvas(m.nx, m.ny);
      this.ovCtx = this.ovCanvas.getContext('2d');
      this.ovImg = this.ovCtx.createImageData(m.nx, m.ny);
      this.cu = new Float32Array(N);
      this.cv = new Float32Array(N);
      this.buildRim();
      this.rebuildBase();
      for (let n = 0; n < STREAK_CAP; n++) this.slife[n] = 0;
      this.invalidateTrails();
    }

    rebuildBase() {
      this.buildBase();
      const m = this.model;
      this.coast = contour(m.elev, m.nx, m.ny, 0.5);
      this.isobaths = [-10, -20, -40].map((L) => contour(m.elev, m.nx, m.ny, L));
    }

    /** non-model cells touching model water: the overlay colour is extended into them so the land layer clips it crisply */
    buildRim() {
      const m = this.model, nx = m.nx, ny = m.ny, mask = m.mask;
      const rim = [], start = [0], nb = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (mask[k]) continue;
        const before = nb.length;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          if (mask[jj * nx + ii]) nb.push(jj * nx + ii);
        }
        if (nb.length > before) { rim.push(k); start.push(nb.length); }
      }
      this.rim = Int32Array.from(rim);
      this.rimStart = Int32Array.from(start);
      this.rimNb = Int32Array.from(nb);
    }

    buildBase() {
      const m = this.model, nx = m.nx, ny = m.ny, R = BASE_RES, W = nx * R, H = ny * R, el = m.elev;
      const E = (gx, gy) => {
        gx = clamp(gx, 0, nx - 1); gy = clamp(gy, 0, ny - 1);
        let i0 = Math.floor(gx), j0 = Math.floor(gy);
        if (i0 > nx - 2) i0 = nx - 2;
        if (j0 > ny - 2) j0 = ny - 2;
        const tx = gx - i0, ty = gy - j0, k = j0 * nx + i0;
        return (el[k] * (1 - tx) + el[k + 1] * tx) * (1 - ty) + (el[k + nx] * (1 - tx) + el[k + nx + 1] * tx) * ty;
      };
      const wc = mkCanvas(W, H), lc = mkCanvas(W, H);
      const wImg = wc.getContext('2d').createImageData(W, H), lImg = lc.getContext('2d').createImageData(W, H);
      const wd = wImg.data, ld = lImg.data;
      const dep = window.Colormaps.lut('depth', 256);
      // light from the north-west, 40 deg elevation
      let Lx = -0.54, Ly = 0.54, Lz = 0.64;
      const Ll = Math.hypot(Lx, Ly, Lz); Lx /= Ll; Ly /= Ll; Lz /= Ll;
      const rgb = this._rgb;
      const rel = (sx, sy, Z) => {
        const a = -sx * Z, b = -sy * Z;
        return (a * Lx + b * Ly + Lz) / Math.sqrt(a * a + b * b + 1) / Lz;
      };
      for (let py = 0; py < H; py++) {
        const gy = ny - 0.5 - (py + 0.5) / R;
        const jr = clamp(Math.round(gy), 0, ny - 1), dxm = m.dxRow[jr], dym = m.dy;
        for (let px = 0; px < W; px++) {
          const gx = -0.5 + (px + 0.5) / R;
          const e = E(gx, gy);
          const dex = E(gx + 0.5, gy) - E(gx - 0.5, gy), dey = E(gx, gy + 0.5) - E(gx, gy - 0.5);
          const slx = dex / dxm, sly = dey / dym;
          const o = (py * W + px) * 4;
          // water: depth tint + faint seabed relief
          const depth = e < 0 ? -e : 0;
          const t = Math.pow(Math.min(1, depth / 70), 0.6);
          const li = ((t * 255 + 0.5) | 0) * 3;
          const fw = clamp(1 + (rel(slx, sly, 120) - 1) * 0.5, 0.8, 1.18);
          wd[o] = dep[li] * fw; wd[o + 1] = dep[li + 1] * fw; wd[o + 2] = dep[li + 2] * fw; wd[o + 3] = 255;
          // land: anti-aliased at the 0.5 m contour (model coast), hillshaded, low ground semi-transparent
          const gp = Math.max(Math.hypot(dex, dey) / R, 0.02);
          const cov = clamp(0.5 + (e - 0.5) / gp, 0, 1);
          if (cov > 0) {
            landColor(e, rgb);
            const fl = clamp(0.3 + 0.7 * rel(slx, sly, 30), 0.45, 1.35);
            const ramp = e < 1.5 ? 0.62 + 0.38 * clamp(e - 0.5, 0, 1) : 1;
            ld[o] = rgb[0] * fl; ld[o + 1] = rgb[1] * fl; ld[o + 2] = rgb[2] * fl; ld[o + 3] = 255 * cov * ramp;
          }
        }
      }
      wc.getContext('2d').putImageData(wImg, 0, 0);
      lc.getContext('2d').putImageData(lImg, 0, 0);
      this.baseWater = wc;
      this.baseLand = lc;
    }

    /* ---------- view transform ---------- */
    get ky() { return this.kx * this.aspect; }

    resize() {
      const c = this.canvas, p = c.parentElement;
      const oldW = this.W, oldH = this.H;
      const center = this.screenToGrid(oldW / 2, oldH / 2), zoom = this.kx / this.fitK;
      const W = Math.max(1, p ? p.clientWidth : c.clientWidth || 300);
      const H = Math.max(1, p ? p.clientHeight : c.clientHeight || 150);
      const dpr = window.devicePixelRatio || 1;
      this.W = W; this.H = H; this.dpr = dpr;
      c.style.display = 'block';
      c.style.width = W + 'px'; c.style.height = H + 'px';
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      this.trailCanvas.width = c.width; this.trailCanvas.height = c.height;
      const m = this.model;
      this.fitK = Math.min(W / m.nx, H / (m.ny * this.aspect)) * 0.97;
      this.nStreak = Math.round(clamp((W * H) / 260, 1000, STREAK_CAP));
      if (!this.userView) this.fit();
      else {
        this.kx = this.fitK * clamp(zoom, ZOOM_MIN, ZOOM_MAX);
        this.ox = W / 2 - center[0] * this.kx;
        this.oy = H / 2 + center[1] * this.ky;
        this.clampPan();
      }
      this.invalidateTrails();
    }

    fit() {
      const m = this.model;
      this.kx = this.fitK;
      this.ox = this.W / 2 - ((m.nx - 1) / 2) * this.kx;
      this.oy = this.H / 2 + ((m.ny - 1) / 2) * this.ky;
      this.userView = false;
      this.invalidateTrails();
    }

    screenToGrid(sx, sy) { return [(sx - this.ox) / this.kx, (this.oy - sy) / this.ky]; }
    gridToScreen(gx, gy) { return [this.ox + gx * this.kx, this.oy - gy * this.ky]; }
    lonLatToScreen(lon, lat) {
      const m = this.model;
      return this.gridToScreen((lon - m.lon0) / m.d, (lat - m.lat0) / m.d);
    }

    zoomAt(sx, sy, factor) {
      const [gx, gy] = this.screenToGrid(sx, sy);
      this.kx = clamp(this.kx * factor, this.fitK * ZOOM_MIN, this.fitK * ZOOM_MAX);
      this.ox = sx - gx * this.kx;
      this.oy = sy + gy * this.ky;
      this.clampPan();
      this.userView = true;
      this.invalidateTrails();
    }

    panBy(dx, dy) {
      this.ox += dx; this.oy += dy;
      this.clampPan();
      this.userView = true;
      this.invalidateTrails();
    }

    /** keep at least a margin of the map inside the viewport */
    clampPan() {
      const m = this.model, kx = this.kx, ky = this.ky;
      const mg = Math.min(80, this.W / 3, this.H / 3);
      const x0 = this.ox - 0.5 * kx, x1 = x0 + m.nx * kx;
      const y0 = this.oy - (m.ny - 0.5) * ky, y1 = y0 + m.ny * ky;
      if (x1 < mg) this.ox += mg - x1; else if (x0 > this.W - mg) this.ox -= x0 - (this.W - mg);
      if (y1 < mg) this.oy += mg - y1; else if (y0 > this.H - mg) this.oy -= y0 - (this.H - mg);
    }

    invalidateTrails() { this.trailsDirty = true; }

    /* ---------- hit tests ---------- */
    hitIndustry(sx, sy) {
      const inds = this.model.industries;
      for (let n = inds.length - 1; n >= 0; n--) {
        const [x, y] = this.lonLatToScreen(inds[n].lon, inds[n].lat);
        if ((x - sx) * (x - sx) + (y - sy) * (y - sy) <= 15 * 15) return inds[n];
      }
      return null;
    }

    hitStation(sx, sy) {
      const st = this.model.stations;
      let best = null, bd = 10 * 10;
      for (const s of st) {
        const [x, y] = this.lonLatToScreen(s.lon, s.lat);
        const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
        if (d <= bd) { bd = d; best = s; }
      }
      return best;
    }

    /* ---------- legend ---------- */
    legend() {
      const L = {
        speed: ['Current speed (m/s)', 'speed', '0', '2.5'],
        eta: ['Sea level (m)', 'diverging', '−5', '+5'],
        contaminant: ['Toxic + organic (mg/L, log)', 'contaminant', '0.001', '10'],
        toxic: ['Toxic (mg/L, log)', 'contaminant', '0.001', '10'],
        organic: ['Organic (mg/L, log)', 'contaminant', '0.001', '10'],
        age: ['Water age (days)', 'age', '0', '20'],
        vorticity: ['Residual vorticity (10⁻⁴ s⁻¹)', 'diverging', '−2', '+2'],
      }[this.layer];
      const stops = [];
      if (!L) {
        for (let i = 0; i < 9; i++) stops.push(window.Colormaps.css('depth', Math.pow(i / 8, 0.6)));
        return { title: 'Depth (m)', stops, min: '0', max: '70+' };
      }
      for (let i = 0; i < 9; i++) stops.push(window.Colormaps.css(L[1], i / 8));
      return { title: L[0], stops, min: L[2], max: L[3] };
    }

    /* ---------- per-frame field overlay ---------- */
    updateOverlay() {
      const m = this.model, nx = m.nx, ny = m.ny, layer = this.layer;
      const d = this.ovImg.data, mask = m.mask, eta = m.eta, h = m.h, HDRY = window.GulfModel.HDRY;
      const cu = this.cu, cv = this.cv;
      let lut = null, mode = 0;
      if (layer === 'speed') { mode = 1; lut = window.Colormaps.lut('speed'); }
      else if (layer === 'eta') { mode = 2; lut = window.Colormaps.lut('diverging'); }
      else if (layer === 'contaminant' || layer === 'toxic' || layer === 'organic') { mode = 3; lut = window.Colormaps.lut('contaminant'); }
      else if (layer === 'age') { mode = 4; lut = window.Colormaps.lut('age'); }
      else if (layer === 'vorticity' && m.hasResidual) { mode = 5; lut = window.Colormaps.lut('diverging'); }
      const T = m.toxic, O = m.organic, AGE = m.age;
      const cA = layer === 'organic' ? null : T, cB = layer === 'toxic' ? null : O;

      if (mode === 1 || mode === 5) {
        const U = mode === 1 ? m.u : m.ru, V = mode === 1 ? m.v : m.rv;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          cu[k] = 0.5 * (U[k] + (i > 0 ? U[k - 1] : 0));
          cv[k] = 0.5 * (V[k] + (j > 0 ? V[k - nx] : 0));
        }
      }

      for (let j = 0; j < ny; j++) {
        const row = (ny - 1 - j) * nx;
        const dx = m.dxRow[j];
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i, o = (row + i) * 4;
          if (!mask[k]) { d[o + 3] = 0; continue; }
          let t = 0, a = 0;
          switch (mode) {
            case 1: t = Math.sqrt(cu[k] * cu[k] + cv[k] * cv[k]) / 2.5; a = 228; break;
            case 2: t = 0.5 + eta[k] / 10; a = 215; break;
            case 3: {
              const c = (cA ? cA[k] : 0) + (cB ? cB[k] : 0);
              if (c >= 0.001) {
                t = (Math.log10(c) + 3) / 4;
                a = 95 + 145 * Math.min(1, t * 1.6);
              }
              break;
            }
            case 4: t = AGE[k] / 20; a = 218; break;
            case 5: {
              if (j > 0 && j < ny - 1 && i > 0 && i < nx - 1) {
                const wE = mask[k + 1], wW = mask[k - 1], wN = mask[k + nx], wS = mask[k - nx];
                let dvdx = 0, dudy = 0;
                if (wE && wW) dvdx = (cv[k + 1] - cv[k - 1]) / (2 * dx);
                else if (wE) dvdx = (cv[k + 1] - cv[k]) / dx;
                else if (wW) dvdx = (cv[k] - cv[k - 1]) / dx;
                if (wN && wS) dudy = (cu[k + nx] - cu[k - nx]) / (2 * m.dy);
                else if (wN) dudy = (cu[k + nx] - cu[k]) / m.dy;
                else if (wS) dudy = (cu[k] - cu[k - nx]) / m.dy;
                t = 0.5 + (dvdx - dudy) / 4e-4;
              } else t = 0.5;
              a = 215;
              break;
            }
          }
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const li = ((t * 255 + 0.5) | 0) * 3;
          let r = 0, g = 0, b = 0;
          if (lut && a > 0) { r = lut[li]; g = lut[li + 1]; b = lut[li + 2]; }
          // drying tidal flats: blend towards mud (premultiplied blend)
          const H = eta[k] + h[k];
          const w = H >= HDRY + 0.4 ? 1 : H <= HDRY ? 0 : (H - HDRY) / 0.4;
          if (w < 1) {
            const aw = a * w, am = MUD_A * (1 - w), ao = aw + am;
            r = (r * aw + MUD[0] * am) / ao; g = (g * aw + MUD[1] * am) / ao; b = (b * aw + MUD[2] * am) / ao;
            a = ao;
          }
          d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
        }
      }
      // extend colour one cell into neighbouring land so the land layer clips it at the coastline
      const rim = this.rim, rs = this.rimStart, rn = this.rimNb;
      for (let n = 0; n < rim.length; n++) {
        let r = 0, g = 0, b = 0, aw = 0, amax = 0;
        for (let q = rs[n]; q < rs[n + 1]; q++) {
          const kk = rn[q], o = ((ny - 1 - ((kk / nx) | 0)) * nx + (kk % nx)) * 4, a = d[o + 3];
          r += d[o] * a; g += d[o + 1] * a; b += d[o + 2] * a; aw += a;
          if (a > amax) amax = a;
        }
        const k = rim[n], o = ((ny - 1 - ((k / nx) | 0)) * nx + (k % nx)) * 4;
        if (aw > 0) { d[o] = r / aw; d[o + 1] = g / aw; d[o + 2] = b / aw; d[o + 3] = amax; }
        else d[o + 3] = 0;
      }
      this.ovCtx.putImageData(this.ovImg, 0, 0);
    }

    /* ---------- flow streaks ---------- */
    respawn(n, gx0, gx1, gy0, gy1) {
      const m = this.model, nx = m.nx, mask = m.mask, eta = m.eta, h = m.h;
      for (let tries = 0; tries < 10; tries++) {
        const x = gx0 + Math.random() * (gx1 - gx0), y = gy0 + Math.random() * (gy1 - gy0);
        const i = Math.round(x), j = Math.round(y);
        if (i < 0 || j < 0 || i >= nx || j >= m.ny) continue;
        const k = j * nx + i;
        if (mask[k] && eta[k] + h[k] > 0.3) {
          this.sx[n] = x; this.sy[n] = y; this.slife[n] = 25 + Math.random() * 90;
          return;
        }
      }
      this.slife[n] = 0;
    }

    drawStreaks(ctx, gx0, gx1, gy0, gy1) {
      const m = this.model, tc = this.trailCtx, dpr = this.dpr;
      const residual = this.flowSource === 'residual';
      if (this.trailsDirty) {
        tc.setTransform(1, 0, 0, 1, 0, 0);
        tc.clearRect(0, 0, this.trailCanvas.width, this.trailCanvas.height);
        this.trailsDirty = false;
      } else {
        tc.setTransform(1, 0, 0, 1, 0, 0);
        tc.globalCompositeOperation = 'destination-out';
        tc.fillStyle = 'rgba(0,0,0,0.075)';
        tc.fillRect(0, 0, this.trailCanvas.width, this.trailCanvas.height);
        tc.globalCompositeOperation = 'source-over';
      }
      if (!residual || m.hasResidual) {
        const U = residual ? m.ru : m.u, V = residual ? m.rv : m.v;
        const boost = residual ? RESIDUAL_BOOST : 1;
        const F = (PX_PER_MPS * boost * this.dxMid) / this.kx;
        const nx = m.nx, ny = m.ny, mask = m.mask, eta = m.eta, h = m.h, HDRY = window.GulfModel.HDRY;
        const dy = m.dy, dxRow = m.dxRow, kx = this.kx, ky = this.ky, ox = this.ox, oy = this.oy;
        const sx = this.sx, sy = this.sy, sl = this.slife, segN = this.segN, buf = this.segBuf;
        segN[0] = segN[1] = segN[2] = segN[3] = 0;
        const pxk = PX_PER_MPS * boost;
        for (let n = 0; n < this.nStreak; n++) {
          if (sl[n] <= 0) { this.respawn(n, gx0, gx1, gy0, gy1); continue; }
          const x = sx[n], y = sy[n];
          const j = y < 0 ? 0 : y > ny - 1 ? ny - 1 : Math.round(y);
          const u = sampleU(m, U, x, y), v = sampleV(m, V, x, y);
          const x2 = x + (u * F) / dxRow[j], y2 = y + (v * F) / dy;
          sl[n] -= 1;
          const i2 = Math.round(x2), j2 = Math.round(y2);
          if (x2 < gx0 || x2 > gx1 || y2 < gy0 || y2 > gy1 || i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) { sl[n] = 0; continue; }
          const k2 = j2 * nx + i2;
          if (!mask[k2] || eta[k2] + h[k2] <= HDRY) { sl[n] = 0; continue; }
          sx[n] = x2; sy[n] = y2;
          const spd = Math.sqrt(u * u + v * v) * pxk;
          if (spd < 0.04) continue;
          const b = spd < 0.45 ? 0 : spd < 1.1 ? 1 : spd < 2.2 ? 2 : 3;
          const o = segN[b] * 4, B = buf[b];
          B[o] = ox + x * kx; B[o + 1] = oy - y * ky; B[o + 2] = ox + x2 * kx; B[o + 3] = oy - y2 * ky;
          segN[b]++;
        }
        tc.setTransform(dpr, 0, 0, dpr, 0, 0);
        tc.lineWidth = residual ? 1.3 : 1.05;
        tc.lineCap = 'butt';
        for (let b = 0; b < 4; b++) {
          const cnt = segN[b];
          if (!cnt) continue;
          const B = buf[b];
          tc.strokeStyle = residual ? `rgba(255,236,200,${STREAK_ALPHA[b]})` : `rgba(255,255,255,${STREAK_ALPHA[b]})`;
          tc.beginPath();
          for (let q = 0; q < cnt * 4; q += 4) { tc.moveTo(B[q], B[q + 1]); tc.lineTo(B[q + 2], B[q + 3]); }
          tc.stroke();
        }
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.trailCanvas, 0, 0);
      ctx.restore();
    }

    /* ---------- arrows ---------- */
    drawArrows(ctx, U, V, boost, color, gx0, gx1, gy0, gy1) {
      const m = this.model, nx = m.nx, mask = m.mask, eta = m.eta, h = m.h, HDRY = window.GulfModel.HDRY;
      const kx = this.kx, ky = this.ky, ox = this.ox, oy = this.oy;
      const step = Math.max(1, Math.round(26 / kx)), spacing = step * kx;
      const iA = Math.max(0, Math.ceil(gx0 / step) * step), iB = Math.min(nx - 1, Math.floor(gx1));
      const jA = Math.max(0, Math.ceil(gy0 / step) * step), jB = Math.min(m.ny - 1, Math.floor(gy1));
      ctx.beginPath();
      for (let j = jA; j <= jB; j += step) for (let i = iA; i <= iB; i += step) {
        const k = j * nx + i;
        if (!mask[k] || eta[k] + h[k] <= HDRY) continue;
        const uc = 0.5 * (U[k] + (i > 0 ? U[k - 1] : 0)), vc = 0.5 * (V[k] + (j > 0 ? V[k - nx] : 0));
        const s = Math.sqrt(uc * uc + vc * vc) * boost;
        if (s < 0.03) continue;
        const len = spacing * 0.8 * Math.min(1.3, s / 1.2) + 3;
        const ex = uc / (s / boost), ey = -vc / (s / boost);
        const cx = ox + i * kx, cy = oy - j * ky;
        const x0 = cx - ex * len * 0.5, y0 = cy - ey * len * 0.5, x1 = cx + ex * len * 0.5, y1 = cy + ey * len * 0.5;
        const hl = Math.min(5, 2 + len * 0.25);
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.moveTo(x1 - ex * hl - ey * hl * 0.6, y1 - ey * hl + ex * hl * 0.6);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x1 - ex * hl + ey * hl * 0.6, y1 - ey * hl - ex * hl * 0.6);
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    /* ---------- drifters ---------- */
    drawDrifters(ctx) {
      const m = this.model, p = m.particles, trails = m.drifterTrails;
      const kx = this.kx, ky = this.ky, ox = this.ox, oy = this.oy, f = this.frame;
      const W = this.W, H = this.H;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const strokeTrail = (pts, hx, hy) => {
        ctx.beginPath();
        let lx = ox + pts[0] * kx, ly = oy - pts[1] * ky;
        ctx.moveTo(lx, ly);
        for (let q = 2; q < pts.length; q += 2) {
          const x = ox + pts[q] * kx, y = oy - pts[q + 1] * ky;
          if (Math.abs(x - lx) + Math.abs(y - ly) < 2 && q < pts.length - 2) continue;
          ctx.lineTo(x, y); lx = x; ly = y;
        }
        if (hx !== undefined) ctx.lineTo(hx, hy);
        ctx.stroke();
      };
      // live drifters
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.85;
      for (let n = 0; n < p.count; n++) {
        if (p.kind[n] !== 0) continue;
        const tr = trails.get(p.id[n]);
        if (!tr) continue;
        tr._seen = f;
        ctx.strokeStyle = GROUP_COLORS[tr.group % GROUP_COLORS.length];
        strokeTrail(tr.pts, ox + p.x[n] * kx, oy - p.y[n] * ky);
      }
      // trails of drifters that have left the domain
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1.2;
      trails.forEach((tr) => {
        if (tr._seen === f || tr.pts.length < 4) return;
        ctx.strokeStyle = GROUP_COLORS[tr.group % GROUP_COLORS.length];
        strokeTrail(tr.pts);
      });
      ctx.globalAlpha = 1;
      // heads: dark outline in one path, then one fill per group colour
      const r = clamp(kx * 0.3, 2.2, 4);
      ctx.beginPath();
      for (let n = 0; n < p.count; n++) {
        if (p.kind[n] !== 0) continue;
        const x = ox + p.x[n] * kx, y = oy - p.y[n] * ky;
        if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
        ctx.moveTo(x + r + 1.2, y); ctx.arc(x, y, r + 1.2, 0, Math.PI * 2);
      }
      ctx.fillStyle = 'rgba(8,10,14,0.85)';
      ctx.fill();
      for (let c = 0; c < GROUP_COLORS.length; c++) {
        let any = false;
        ctx.beginPath();
        for (let n = 0; n < p.count; n++) {
          if (p.kind[n] !== 0 || p.group[n] % GROUP_COLORS.length !== c) continue;
          const x = ox + p.x[n] * kx, y = oy - p.y[n] * ky;
          if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
          ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
          any = true;
        }
        if (any) { ctx.fillStyle = GROUP_COLORS[c]; ctx.fill(); }
      }
    }

    /* ---------- plume + oil particles ---------- */
    drawPollutionParticles(ctx) {
      const m = this.model, p = m.particles, KIND = window.GulfModel.KIND;
      const kx = this.kx, ky = this.ky, ox = this.ox, oy = this.oy, W = this.W + 4, H = this.H + 4;
      const s = clamp(kx * 0.22, 1.4, 3.2), hs = s / 2;
      const cols = this._colors;
      cols.length = 0;
      let nOil = 0;
      for (let n = 0; n < p.count; n++) {
        const k = p.kind[n];
        if (k === KIND.PLUME) { const c = p.color[n] || '#ff5fd2'; if (cols.indexOf(c) < 0) cols.push(c); }
        else if (k === KIND.OIL) nOil++;
      }
      ctx.globalAlpha = 0.82;
      for (let ci = 0; ci < cols.length; ci++) {
        const col = cols[ci];
        ctx.beginPath();
        for (let n = 0; n < p.count; n++) {
          if (p.kind[n] !== KIND.PLUME || (p.color[n] || '#ff5fd2') !== col) continue;
          const x = ox + p.x[n] * kx, y = oy - p.y[n] * ky;
          if (x < -4 || y < -4 || x > W || y > H) continue;
          ctx.rect(x - hs, y - hs, s, s);
        }
        ctx.fillStyle = col;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (nOil) {
        // oil: light sheen halo then dark core
        const hs2 = hs + 1;
        ctx.beginPath();
        for (let n = 0; n < p.count; n++) {
          if (p.kind[n] !== KIND.OIL) continue;
          const x = ox + p.x[n] * kx, y = oy - p.y[n] * ky;
          if (x < -4 || y < -4 || x > W || y > H) continue;
          ctx.rect(x - hs2, y - hs2, s + 2, s + 2);
        }
        ctx.fillStyle = 'rgba(214,176,110,0.28)';
        ctx.fill();
        ctx.beginPath();
        for (let n = 0; n < p.count; n++) {
          if (p.kind[n] !== KIND.OIL) continue;
          const x = ox + p.x[n] * kx, y = oy - p.y[n] * ky;
          if (x < -4 || y < -4 || x > W || y > H) continue;
          ctx.rect(x - hs, y - hs, s, s);
        }
        ctx.fillStyle = 'rgba(30,19,10,0.95)';
        ctx.fill();
      }
    }

    /* ---------- markers ---------- */
    drawIndustries(ctx, ui) {
      const m = this.model, nx = m.nx;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const ind of m.industries) {
        const [x, y] = this.lonLatToScreen(ind.lon, ind.lat);
        if (x < -60 || y < -40 || x > this.W + 60 || y > this.H + 40) continue;
        const sel = ui.selectedIndustryId === ind.id;
        const col = (ind.mix && ind.mix.color) || '#9aa0a6';
        // outfall link
        if (ind.k >= 0) {
          const [qx, qy] = this.gridToScreen(ind.k % nx, (ind.k / nx) | 0);
          if (Math.abs(qx - x) + Math.abs(qy - y) > 14) {
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(qx, qy); ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.beginPath(); ctx.arc(qx, qy, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = col; ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1; ctx.stroke();
        }
        const R = 12;
        ctx.globalAlpha = ind.on ? 1 : 0.5;
        if (sel) {
          const pulse = 0.5 + 0.5 * Math.sin(this.frame * 0.12);
          ctx.beginPath(); ctx.arc(x, y, R + 4 + pulse * 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.35 * pulse})`; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.8)'; ctx.stroke();
        ctx.font = `13px ${EMOJI_FONT}`;
        ctx.fillStyle = '#fff';
        ctx.fillText(ind.icon || '🏭', x, y + 1);
        if (!ind.on) {
          ctx.beginPath(); ctx.moveTo(x - R * 0.7, y + R * 0.7); ctx.lineTo(x + R * 0.7, y - R * 0.7);
          ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (this.show.labels && ind.name) {
          ctx.font = `${sel ? '600 ' : ''}11px ${FONT}`;
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,9,13,0.85)'; ctx.lineJoin = 'round';
          ctx.fillStyle = sel ? '#ffffff' : '#e6e9ee';
          haloText(ctx, ind.name, x, y + R + 9);
        }
      }
    }

    drawStations(ctx, ui) {
      const st = this.model.stations;
      let hoverS = null;
      if (ui.hover) {
        const [hx, hy] = this.gridToScreen(ui.hover.gx, ui.hover.gy);
        hoverS = this.hitStation(hx, hy);
      }
      // link the observation point to the model cell it is compared with
      const nx = this.model.nx;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      for (const s of st) {
        if (!(s.k >= 0)) continue;
        const [x, y] = this.lonLatToScreen(s.lon, s.lat);
        const [qx, qy] = this.gridToScreen(s.k % nx, (s.k / nx) | 0);
        if (Math.abs(qx - x) + Math.abs(qy - y) < 8) continue;
        ctx.moveTo(x, y); ctx.lineTo(qx, qy);
        ctx.moveTo(qx + 2, qy); ctx.arc(qx, qy, 2, 0, Math.PI * 2);
      }
      ctx.strokeStyle = 'rgba(95,227,255,0.6)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const s of st) {
        const [x, y] = this.lonLatToScreen(s.lon, s.lat);
        ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
      }
      ctx.fillStyle = '#5fe3ff'; ctx.fill();
      ctx.strokeStyle = 'rgba(4,16,24,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
      if (hoverS) {
        const [x, y] = this.lonLatToScreen(hoverS.lon, hoverS.lat);
        ctx.font = `600 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,9,13,0.9)'; ctx.lineJoin = 'round';
        ctx.fillStyle = '#9ff0ff';
        haloText(ctx, hoverS.name, x + 9, y);
      }
    }

    drawCities(ctx) {
      const boxes = this._boxes;
      boxes.length = 0;
      if (this.show.industries) {
        // keep city names clear of industry icons and their labels
        for (const ind of this.model.industries) {
          const [x, y] = this.lonLatToScreen(ind.lon, ind.lat);
          boxes.push(x - 14, y - 14, 28, 28);
          if (ind.name) { const hw = ind.name.length * 3.2; boxes.push(x - hw, y + 14, 2 * hw, 14); }
        }
      }
      ctx.font = `11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,9,13,0.8)'; ctx.lineJoin = 'round';
      for (let c = 0; c < CITIES.length; c++) {
        const [name, lat, lon] = CITIES[c];
        const [x, y] = this.lonLatToScreen(lon, lat);
        if (x < -40 || y < -20 || x > this.W + 10 || y > this.H + 20) continue;
        const w = ctx.measureText(name).width;
        const bx = x - 3, by = y - 7, bw = w + 10, bh = 14;
        let clash = false;
        for (let q = 0; q < boxes.length; q += 4) {
          if (bx < boxes[q] + boxes[q + 2] && bx + bw > boxes[q] && by < boxes[q + 1] + boxes[q + 3] && by + bh > boxes[q + 1]) { clash = true; break; }
        }
        ctx.beginPath(); ctx.arc(x, y, 2.3, 0, Math.PI * 2);
        ctx.fillStyle = '#f2ead8'; ctx.fill();
        ctx.strokeStyle = 'rgba(6,9,13,0.8)'; ctx.lineWidth = 1; ctx.stroke();
        if (clash) continue;
        boxes.push(bx, by, bw, bh);
        ctx.lineWidth = 3;
        ctx.fillStyle = 'rgba(242,236,222,0.92)';
        haloText(ctx, name, x + 5, y);
      }
    }

    drawPointer(ctx, ui) {
      if (ui.probe) {
        const [x, y] = this.gridToScreen(ui.probe.gx, ui.probe.gy);
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.moveTo(x - 12, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 12, y);
        ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 12);
        ctx.stroke();
        ctx.strokeStyle = '#ff9f1c'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fillStyle = '#ff9f1c'; ctx.fill();
      }
      if (ui.hover) {
        const [x, y] = this.gridToScreen(ui.hover.gx, ui.hover.gy);
        if (ui.placing) {
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.setLineDash([]);
          const icon = PLACE_ICONS[ui.placing.type];
          ctx.globalAlpha = 0.75;
          if (icon) {
            ctx.font = `15px ${EMOJI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff'; ctx.fillText(icon, x, y + 1);
          } else {
            ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
            ctx.strokeStyle = '#fff'; ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else {
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
    }

    /* ---------- cartographic furniture ---------- */
    graticuleStep() {
      const pxPerDeg = this.kx / this.model.d;
      for (const s of [0.05, 0.1, 0.2, 0.5, 1]) if (s * pxPerDeg >= 90) return s;
      return 1;
    }

    mapRect() {
      const m = this.model, kx = this.kx, ky = this.ky;
      const x0 = this.ox - 0.5 * kx, y0 = this.oy - (m.ny - 0.5) * ky;
      return [x0, y0, m.nx * kx, m.ny * ky];
    }

    drawGraticuleLines(ctx) {
      const m = this.model, step = this.graticuleStep();
      const [x0, y0, w, h] = this.mapRect();
      const lonA = m.lon0 - 0.5 * m.d, lonB = lonA + m.nx * m.d, latA = m.lat0 - 0.5 * m.d, latB = latA + m.ny * m.d;
      ctx.beginPath();
      for (let q = Math.ceil(lonA / step - 1e-9); q * step <= lonB; q++) {
        const [x] = this.lonLatToScreen(q * step, m.lat0);
        ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y0 + h);
      }
      for (let q = Math.ceil(latA / step - 1e-9); q * step <= latB; q++) {
        const [, y] = this.lonLatToScreen(m.lon0, q * step);
        ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x0 + w, Math.round(y) + 0.5);
      }
      ctx.strokeStyle = 'rgba(220,235,255,0.07)'; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(220,235,255,0.22)';
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
    }

    drawGraticuleLabels(ctx) {
      const m = this.model, step = this.graticuleStep(), dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
      const [x0, y0, w, h] = this.mapRect();
      const top = Math.max(0, y0), left = Math.max(0, x0), right = Math.min(this.W, x0 + w), bottom = Math.min(this.H, y0 + h);
      const lonA = m.lon0 - 0.5 * m.d, lonB = lonA + m.nx * m.d, latA = m.lat0 - 0.5 * m.d, latB = latA + m.ny * m.d;
      ctx.font = `10px ${FONT}`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,9,13,0.75)'; ctx.lineJoin = 'round';
      ctx.fillStyle = 'rgba(214,226,240,0.7)';
      ctx.beginPath();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let q = Math.ceil(lonA / step - 1e-9); q * step <= lonB; q++) {
        const [x] = this.lonLatToScreen(q * step, m.lat0);
        if (x < left + 20 || x > right - 20) continue;
        haloText(ctx, (q * step).toFixed(dec) + '°E', x, top + 8);
        ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, top + 5);
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (let q = Math.ceil(latA / step - 1e-9); q * step <= latB; q++) {
        const [, y] = this.lonLatToScreen(m.lon0, q * step);
        if (y < top + 24 || y > Math.min(bottom - 12, this.H - 100)) continue;
        haloText(ctx, (q * step).toFixed(dec) + '°N', left + 8, y);
        ctx.moveTo(left, Math.round(y) + 0.5); ctx.lineTo(left + 5, Math.round(y) + 0.5);
      }
      ctx.strokeStyle = 'rgba(214,226,240,0.6)'; ctx.lineWidth = 1;
      ctx.stroke();
    }

    drawScaleBar(ctx) {
      const mPerPx = this.dxMid / this.kx;
      const target = (110 * mPerPx) / 1000;
      let km = 1;
      for (const c of [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200]) if (c <= target) km = c;
      const len = (km * 1000) / mPerPx;
      const x = 16, y = this.H - 18;
      ctx.fillStyle = 'rgba(6,9,13,0.55)';
      ctx.fillRect(x - 6, y - 22, len + 12, 30);
      ctx.fillStyle = '#e8edf3';
      ctx.fillRect(x, y - 3, len / 2, 4);
      ctx.fillStyle = 'rgba(232,237,243,0.25)';
      ctx.fillRect(x + len / 2, y - 3, len / 2, 4);
      ctx.strokeStyle = '#e8edf3'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y - 3.5, len - 1, 5);
      ctx.font = `10px ${FONT}`; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#e8edf3';
      ctx.textAlign = 'left'; ctx.fillText('0', x, y - 6);
      ctx.textAlign = 'right'; ctx.fillText(km + ' km', x + len, y - 6);

      // north arrow above the scale bar
      const cx = 30, cy = this.H - 66;
      ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6,9,13,0.55)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx, cy - 11); ctx.lineTo(cx + 5, cy + 5); ctx.lineTo(cx, cy + 2); ctx.closePath();
      ctx.fillStyle = '#e8edf3'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx, cy - 11); ctx.lineTo(cx - 5, cy + 5); ctx.lineTo(cx, cy + 2); ctx.closePath();
      ctx.fillStyle = 'rgba(232,237,243,0.45)'; ctx.fill();
      ctx.font = `600 9px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#e8edf3'; ctx.fillText('N', cx, cy + 5);
    }

    strokeSegments(ctx, segs) {
      const kx = this.kx, ky = this.ky, ox = this.ox, oy = this.oy;
      ctx.beginPath();
      for (let q = 0; q < segs.length; q += 4) {
        ctx.moveTo(ox + segs[q] * kx, oy - segs[q + 1] * ky);
        ctx.lineTo(ox + segs[q + 2] * kx, oy - segs[q + 3] * ky);
      }
      ctx.stroke();
    }

    /* ---------- main entry ---------- */
    draw(ui) {
      ui = ui || {};
      const m = this.model, ctx = this.ctx, show = this.show;
      this.frame++;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#070b11';
      ctx.fillRect(0, 0, this.W, this.H);

      const [x0, y0, w, h] = this.mapRect();
      // visible grid window
      const gx0 = Math.max(-0.5, -this.ox / this.kx), gx1 = Math.min(m.nx - 0.5, (this.W - this.ox) / this.kx);
      const gy0 = Math.max(-0.5, (this.oy - this.H) / this.ky), gy1 = Math.min(m.ny - 0.5, this.oy / this.ky);

      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.baseWater, x0, y0, w, h);
      this.updateOverlay();
      ctx.drawImage(this.ovCanvas, x0, y0, w, h);
      ctx.drawImage(this.baseLand, x0, y0, w, h);

      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (this.layer === 'none') {
        ctx.strokeStyle = 'rgba(170,215,235,0.13)'; ctx.lineWidth = 0.8;
        for (const seg of this.isobaths) this.strokeSegments(ctx, seg);
      }
      ctx.strokeStyle = 'rgba(236,226,196,0.6)'; ctx.lineWidth = 1;
      this.strokeSegments(ctx, this.coast);
      this.drawGraticuleLines(ctx);

      if (show.arrows || (show.residualArrows && m.hasResidual)) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
        if (show.arrows) this.drawArrows(ctx, m.u, m.v, 1, 'rgba(255,255,255,0.9)', gx0, gx1, gy0, gy1);
        if (show.residualArrows && m.hasResidual) this.drawArrows(ctx, m.ru, m.rv, RESIDUAL_BOOST, '#ffb347', gx0, gx1, gy0, gy1);
        ctx.restore();
      }

      if (show.particles && gx1 > gx0 && gy1 > gy0) this.drawStreaks(ctx, gx0, gx1, gy0, gy1);
      else if (!this.trailsDirty) this.invalidateTrails();

      if (show.drifters) this.drawDrifters(ctx);
      if (show.plume) this.drawPollutionParticles(ctx);
      if (show.stations) this.drawStations(ctx, ui);
      if (show.labels) this.drawCities(ctx);
      if (show.industries) this.drawIndustries(ctx, ui);
      this.drawPointer(ctx, ui);
      this.drawGraticuleLabels(ctx);
      this.drawScaleBar(ctx);
    }
  }

  window.MapRenderer = MapRenderer;
})();
