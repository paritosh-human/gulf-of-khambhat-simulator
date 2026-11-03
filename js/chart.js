/* Time-series chart under the map
 *
 * Top panel   : sea level at the selected station — Open-Meteo (real) vs model
 * Bottom panel: contaminant at the probe (orange, auto scale) + 10 m wind speed (faint blue, right axis)
 * Day ticks in IST (Asia/Kolkata, UTC+5:30), cursor at tNow, click / drag to seek, hover read-out.
 */
(function () {
  'use strict';
  const IST = 5.5 * 3600 * 1000;
  const DAY_MS = 86400 * 1000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const C = {
    text: '#9fb3c8', grid: 'rgba(255,255,255,0.06)', zero: 'rgba(255,255,255,0.14)',
    obs: 'rgba(225,232,240,0.75)', model: '#22d3ee', probe: '#fb923c', wind: 'rgba(125,170,255,0.45)',
    cursor: '#fde047', hover: 'rgba(255,255,255,0.35)', panel: 'rgba(255,255,255,0.025)',
  };
  const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

  function istParts(ms) {
    const d = new Date(ms + IST);
    return { day: d.getUTCDate(), mon: MONTHS[d.getUTCMonth()], hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDay(ms) { const p = istParts(ms); return p.day + ' ' + p.mon; }
  function fmtTime(ms) { const p = istParts(ms); return p.day + ' ' + p.mon + ' ' + pad2(p.hh) + ':' + pad2(p.mm) + ' IST'; }

  /** "nice" step for an axis spanning `range` with about `n` ticks */
  function niceStep(range, n) {
    const raw = range / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function fmtNum(v, step) {
    const dec = Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
    return v.toFixed(dec);
  }
  function fmtConc(v) {
    if (!isFinite(v)) return '–';
    if (v === 0) return '0';
    if (v >= 100) return v.toFixed(0);
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.001) return v.toPrecision(2);
    return v.toExponential(1);
  }

  class TideChart {
    constructor(canvas, model) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.model = model;
      this.onSeek = null;
      this.ui = { stationIndex: 0, tNow: 0 };
      this.hoverX = null;
      this.dragging = false;
      this.cssW = 0; this.cssH = 0; this.dpr = 1;
      this.plot = null;
      this.resize();
      this.bindEvents();
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(() => { if (this.resize()) this.redraw(); });
        this.ro.observe(canvas);
      }
    }

    /** match the backing store to the CSS size × devicePixelRatio; returns true if it changed */
    resize() {
      const c = this.canvas, dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(c.clientWidth || c.width)), h = Math.max(1, Math.round(c.clientHeight || c.height));
      if (w === this.cssW && h === this.cssH && dpr === this.dpr) return false;
      this.cssW = w; this.cssH = h; this.dpr = dpr;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      return true;
    }

    /* ---------- interaction ---------- */
    bindEvents() {
      const c = this.canvas;
      const xOf = (e) => e.clientX - c.getBoundingClientRect().left;
      c.style.touchAction = 'none';
      c.style.cursor = 'crosshair';
      c.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        this.dragging = true;
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        this.seekAt(xOf(e));
        e.preventDefault();
      });
      c.addEventListener('pointermove', (e) => {
        this.hoverX = xOf(e);
        if (this.dragging) this.seekAt(this.hoverX);
        this.redraw();
      });
      const end = (e) => {
        if (!this.dragging) return;
        this.dragging = false;
        try { c.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => { if (!this.dragging) { this.hoverX = null; this.redraw(); } });
    }

    seekAt(x) {
      const p = this.plot;
      if (!p || typeof this.onSeek !== 'function') return;
      const t = this.xToT(x);
      this.onSeek(Math.max(0, Math.min(this.model.tEnd, t)));
    }
    tToX(t) { const p = this.plot; return p.x0 + (t / Math.max(1, this.model.tEnd)) * (p.x1 - p.x0); }
    xToT(x) { const p = this.plot; return ((x - p.x0) / Math.max(1, p.x1 - p.x0)) * this.model.tEnd; }

    redraw() { this.draw(this.ui); }

    /* ---------- drawing ---------- */
    draw(ui) {
      if (ui) this.ui = ui;
      if (!this.ro) this.resize(); // no ResizeObserver: poll client size
      const m = this.model, ctx = this.ctx, W = this.cssW, H = this.cssH, dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!m || !m.hours || W < 60 || H < 60) return;

      const padL = 44, padR = 40, padT = 16, padB = 18, gap = 12;
      const x0 = padL, x1 = W - padR;
      const avail = H - padT - padB - gap;
      const topH = Math.round(avail * 0.62);
      const top = { y0: padT, y1: padT + topH };
      const bot = { y0: padT + topH + gap, y1: H - padB };
      this.plot = { x0, x1, top, bot };

      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      for (const pnl of [top, bot]) { ctx.fillStyle = C.panel; ctx.fillRect(x0, pnl.y0, x1 - x0, pnl.y1 - pnl.y0); }

      this.drawDayTicks(top, bot);
      const st = m.stations[this.ui.stationIndex | 0] || m.stations[0];
      const hovT = this.hoverX != null && this.hoverX >= x0 && this.hoverX <= x1 ? this.xToT(this.hoverX) : null;
      const read = { st: st ? st.name : '' };

      /* --- top panel: sea level */
      if (st) {
        let lo = Infinity, hi = -Infinity;
        for (const arr of [st.etaObs, st.etaModel]) for (let i = 0; i < arr.length; i++) {
          const v = arr[i]; if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        if (!isFinite(lo)) { lo = -1; hi = 1; }
        const padv = Math.max(0.1, (hi - lo) * 0.08); lo -= padv; hi += padv;
        const yOf = (v) => top.y1 - ((v - lo) / (hi - lo)) * (top.y1 - top.y0);
        this.yAxis(top, lo, hi, yOf, 'left', 'm', C.text);
        if (lo < 0 && hi > 0) this.hline(yOf(0), C.zero);
        this.series(st.etaObs, yOf, C.obs, 1);
        this.series(st.etaModel, yOf, C.model, 1.6);
        // legend + station name
        ctx.textAlign = 'left';
        let lx = x0 + 6; const ly = top.y0 + 9;
        ctx.fillStyle = C.text; ctx.fillText('Sea level · ' + st.name, lx, ly); lx += ctx.measureText('Sea level · ' + st.name).width + 14;
        lx = this.legendItem(lx, ly, C.obs, 'Open-Meteo (real)'); this.legendItem(lx, ly, C.model, 'Model');
        if (hovT != null) { read.obs = this.valueAt(st.etaObs, hovT); read.mod = this.valueAt(st.etaModel, hovT); }
      }

      /* --- bottom panel: probe contaminant + wind */
      const ps = m.probeSeries;
      let cmax = 0;
      for (let i = 0; i < ps.length; i++) if (isFinite(ps[i]) && ps[i] > cmax) cmax = ps[i];
      cmax = niceMax(cmax > 0 ? cmax * 1.05 : 0.01);
      const ws = m.data && m.data.wind ? m.data.wind.speed : null;
      let wmax = 0;
      if (ws) for (let i = 0; i < ws.length; i++) if (ws[i] > wmax) wmax = ws[i];
      wmax = Math.max(5, niceMax(wmax * 1.05));
      const yC = (v) => bot.y1 - (v / cmax) * (bot.y1 - bot.y0);
      const yW = (v) => bot.y1 - (v / wmax) * (bot.y1 - bot.y0);
      this.yAxis(bot, 0, cmax, yC, 'left', '', C.probe, true);
      this.yAxis(bot, 0, wmax, yW, 'right', 'm/s', C.wind);
      if (ws) this.series(ws, yW, C.wind, 1);
      this.series(ps, yC, C.probe, 1.6);
      ctx.textAlign = 'left';
      let lx = x0 + 6; const ly = bot.y0 + 9;
      lx = this.legendItem(lx, ly, C.probe, 'Contaminant at probe (mg/L)');
      this.legendItem(lx, ly, C.wind, 'Wind 10 m (m/s)');
      if (hovT != null) { read.c = this.valueAt(ps, hovT); read.w = ws ? this.valueAt(ws, hovT) : NaN; }

      /* --- hover line + read-out */
      if (hovT != null) {
        const hx = this.tToX(hovT);
        ctx.strokeStyle = C.hover; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, top.y0); ctx.lineTo(Math.round(hx) + 0.5, bot.y1); ctx.stroke();
        const lines = [
          fmtTime(m.time0 + hovT * 1000),
          'Real ' + (isFinite(read.obs) ? read.obs.toFixed(2) + ' m' : '–') + '   Model ' + (isFinite(read.mod) ? read.mod.toFixed(2) + ' m' : '–'),
          'Conc ' + fmtConc(read.c) + ' mg/L   Wind ' + (isFinite(read.w) ? read.w.toFixed(1) + ' m/s' : '–'),
        ];
        let bw = 0; for (const s of lines) bw = Math.max(bw, ctx.measureText(s).width);
        bw += 12; const bh = lines.length * 14 + 6;
        let bx = hx + 10; if (bx + bw > x1) bx = hx - 10 - bw;
        const by = top.y0 + 20;
        ctx.fillStyle = 'rgba(10,18,30,0.85)'; ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.textAlign = 'left'; ctx.fillStyle = '#dbe7f3';
        lines.forEach((s, i) => ctx.fillText(s, bx + 6, by + 10 + i * 14));
      }

      /* --- cursor at tNow */
      const tNow = Math.max(0, Math.min(m.tEnd, this.ui.tNow || 0));
      const cx = Math.round(this.tToX(tNow)) + 0.5;
      ctx.strokeStyle = C.cursor; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(cx, top.y0 - 2); ctx.lineTo(cx, bot.y1); ctx.stroke();
      const label = fmtTime(m.time0 + tNow * 1000);
      const tw = ctx.measureText(label).width + 8;
      let tx = cx - tw / 2; tx = Math.max(x0, Math.min(x1 - tw, tx));
      ctx.fillStyle = 'rgba(253,224,71,0.9)'; ctx.fillRect(tx, 1, tw, 13);
      ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.fillText(label, tx + 4, 8);
    }

    drawDayTicks(top, bot) {
      const m = this.model, ctx = this.ctx, { x0, x1 } = this.plot;
      const tEndMs = m.time0 + m.tEnd * 1000;
      const pxPerDay = ((x1 - x0) * 86400) / Math.max(1, m.tEnd);
      const every = pxPerDay > 34 ? 1 : pxPerDay > 17 ? 2 : pxPerDay > 8 ? 5 : 7;
      // first IST midnight at or after time0
      let ms = Math.ceil((m.time0 + IST) / DAY_MS) * DAY_MS - IST;
      ctx.textAlign = 'center';
      for (; ms <= tEndMs; ms += DAY_MS) {
        const x = Math.round(this.tToX((ms - m.time0) / 1000)) + 0.5;
        const d = istParts(ms).day;
        const labelled = every === 1 || (d - 1) % every === 0;
        ctx.strokeStyle = labelled ? C.grid : 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, top.y0); ctx.lineTo(x, top.y1); ctx.moveTo(x, bot.y0); ctx.lineTo(x, bot.y1); ctx.stroke();
        if (labelled && x > x0 + 10 && x < x1 - 10) { ctx.fillStyle = C.text; ctx.fillText(fmtDay(ms), x, bot.y1 + 9); }
      }
    }

    yAxis(pnl, lo, hi, yOf, side, unit, color, concFmt) {
      const ctx = this.ctx, { x0, x1 } = this.plot;
      const n = Math.max(2, Math.floor((pnl.y1 - pnl.y0) / 28));
      const step = niceStep(hi - lo, n);
      ctx.textAlign = side === 'left' ? 'right' : 'left';
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        if (side === 'left') { ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
        ctx.fillStyle = color === C.wind ? 'rgba(125,170,255,0.8)' : color;
        const s = concFmt ? fmtConc(v) : fmtNum(Math.abs(v) < step / 1e6 ? 0 : v, step);
        ctx.fillText(s, side === 'left' ? x0 - 5 : x1 + 5, y);
      }
      if (unit) {
        ctx.fillStyle = C.text; ctx.textAlign = side === 'left' ? 'right' : 'left';
        ctx.fillText(unit, side === 'left' ? x0 - 5 : x1 + 5, pnl.y0 - 6 < 8 ? pnl.y0 + 4 : pnl.y0 - 4);
      }
    }

    hline(y, color) {
      const ctx = this.ctx, { x0, x1 } = this.plot;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke();
    }

    /** hourly series → polyline, broken at NaN / null */
    series(arr, yOf, color, width) {
      const ctx = this.ctx, n = Math.min(arr.length, this.model.hours);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v == null || !isFinite(v)) { pen = false; continue; }
        const x = this.tToX(i * 3600), y = yOf(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    }

    legendItem(x, y, color, label) {
      const ctx = this.ctx;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 14, y); ctx.stroke();
      ctx.fillStyle = C.text; ctx.textAlign = 'left';
      ctx.fillText(label, x + 18, y);
      return x + 18 + ctx.measureText(label).width + 14;
    }

    /** linear interpolation in an hourly series (NaN if either neighbour missing) */
    valueAt(arr, t) {
      const x = Math.max(0, Math.min(this.model.hours - 1, t / 3600)), i = Math.floor(x), f = x - i;
      const a = arr[i], b = i + 1 < arr.length ? arr[i + 1] : a;
      if (a == null || b == null) return NaN;
      return a * (1 - f) + b * f;
    }
  }

  window.TideChart = TideChart;
})();
