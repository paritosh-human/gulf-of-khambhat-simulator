/* Video recorder: renders a tidal cycle frame-by-frame (fixed sim time per frame) into a 1600x900
   composite (map + info panel), encodes H.264 with WebCodecs and writes a standard seekable MP4
   with the small built-in muxer below (no external libraries). */
(function () {
  'use strict';
  const HOUR = 3600;
  const W = 1600, H = 900, MAPW = 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** semidiurnal cycle (low -> high -> low, 10-15 h long) with the largest or smallest range at a station */
  function findCycle(model, stationIndex = 0, which = 'max') {
    const e = model.stations[stationIndex].etaObs, ext = [];
    for (let i = 1; i < e.length - 1; i++) if ((e[i] - e[i - 1]) * (e[i + 1] - e[i]) < 0) ext.push(i);
    let best = null;
    for (let a = 0; a + 2 < ext.length; a++) {
      const [i0, i1, i2] = [ext[a], ext[a + 1], ext[a + 2]];
      if (e[i1] <= e[i0] || e[i1] <= e[i2]) continue;
      if (i2 - i0 < 10 || i2 - i0 > 15) continue;
      const range = e[i1] - (e[i0] + e[i2]) / 2;
      if (!best || (which === 'max' ? range > best.range : range < best.range)) best = { which, range, tStart: i0 * HOUR, tHigh: i1 * HOUR, tEnd: i2 * HOUR };
    }
    return best;
  }

  /**
   * opts: which ('max'|'min'), pad (fraction of a cycle added before and after, default 0.5),
   *       fps, seconds, mapPx, layer, stationIndex, onProgress(phase, fraction)
   * returns { blob (video/mp4), cycle, window: [t0, t1] }
   */
  async function recordCycle(app, opts = {}) {
    const { model, map, ui } = app;
    const st = opts.stationIndex || 0;
    const cyc = opts.cycle || findCycle(model, st, opts.which || 'max');
    const pad = (opts.pad ?? 0.5) * (cyc.tEnd - cyc.tStart);
    const t0 = Math.max(6 * HOUR, cyc.tStart - pad), t1 = Math.min(model.tEnd - HOUR, cyc.tEnd + pad);
    const fps = opts.fps || 30, seconds = opts.seconds || 40;
    const nFrames = Math.round(fps * seconds);
    const simPerFrame = (t1 - t0) / nFrames;
    const station = model.stations[st];
    const onProgress = opts.onProgress || (() => {});

    // big square map for the recording
    const wrap = document.getElementById('mapwrap');
    const saved = wrap.getAttribute('style') || '';
    wrap.setAttribute('style', `position:fixed;left:0;top:0;width:${opts.mapPx || 900}px;height:${opts.mapPx || 900}px;z-index:50`);
    map.resize(); map.fit();
    const prevLayer = map.layer, prevPlaying = ui.playing;
    map.layer = opts.layer || 'speed';
    ui.playing = false; ui.hover = null;

    // spin up so the flow is fully developed when recording starts; optionally run industries for
    // `preRunDays` beforehand so pollution plumes are established
    const pre = (opts.preRunDays || 0) * 86400;
    app.jumpTo(t0 - pre);
    while (model.spinningUp) { await sleep(50); onProgress('spin-up', 1 - (model.targetT - model.t) / (model.targetT - model.tRamp)); }
    if (pre) {
      if (opts.clearPollution !== false) model.clearPollution();
      while (model.t < t0) {
        const c = performance.now();
        while (model.t < t0 && performance.now() - c < 40) model.step();
        onProgress('pre-run', 1 - (t0 - model.t) / pre);
        await sleep(0);
      }
    }

    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g = out.getContext('2d');
    const mux = new Mp4Writer(W, H, fps);
    let encErr = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => mux.add(chunk, meta), error: (e) => (encErr = e) });
    enc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 10e6, framerate: fps, avc: { format: 'avc' } });

    const series = [];
    const view = { t0, t1, cyc, title: opts.title || 'Depth-averaged tidal current speed' };
    for (let f = 0; f <= nFrames; f++) {
      const target = t0 + f * simPerFrame;
      while (model.t < target) model.step();
      ui.hover = null;
      map.draw(ui);
      const stats = speedStats(model);
      series.push({ t: model.t, eta: model.eta[station.k] });
      compose(g, app, view, station, stats, series);
      const vf = new VideoFrame(out, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: f % (2 * fps) === 0 });
      vf.close();
      if (encErr) throw encErr;
      onProgress('frames', f / nFrames);
      await sleep(enc.encodeQueueSize > 8 ? 15 : 0);
    }
    await enc.flush();
    enc.close();

    wrap.setAttribute('style', saved);
    map.layer = prevLayer; ui.playing = prevPlaying;
    map.resize(); map.fit();
    return { blob: mux.finish(), cycle: cyc, window: [t0, t1] };
  }

  function speedStats(m) {
    let max = 0, sum = 0, n = 0;
    for (const k of m.interior) {
      if (m.eta[k] + m.h[k] < 0.5) continue;
      const i = k % m.nx, j = (k / m.nx) | 0;
      const s = Math.hypot(m.sampleU(i, j, m.u), m.sampleV(i, j, m.v));
      sum += s; n++;
      if (s > max) max = s;
    }
    return { max, mean: sum / n };
  }

  function compose(g, app, view, station, stats, series) {
    const { model, map } = app;
    const { t0, t1, cyc } = view;
    const mapCanvas = document.getElementById('map');
    g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
    const s = Math.min(MAPW / mapCanvas.width, H / mapCanvas.height);
    const mw = mapCanvas.width * s, mh = mapCanvas.height * s;
    g.drawImage(mapCanvas, (MAPW - mw) / 2, (H - mh) / 2, mw, mh);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(MAPW, 0, 1, H);

    const x = MAPW + 40;
    const ist = (t, o) => new Date(model.time0 + t * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...o });
    const hm = (t) => ist(t, { hour: '2-digit', minute: '2-digit', hour12: false });
    g.textBaseline = 'top';
    g.fillStyle = '#dbe6f3'; g.font = '600 30px Segoe UI, sans-serif';
    g.fillText('Gulf of Khambhat', x, 40);
    g.font = '18px Segoe UI, sans-serif'; g.fillStyle = '#8a9bb3';
    g.fillText(view.title, x, 80);
    g.fillText(`${cyc.which === 'min' ? 'Smallest (neap)' : 'Largest (spring)'} tide of the 30 days · ${cyc.range.toFixed(1)} m range at ${station.name.split(' ')[0]}`, x, 104);

    g.fillStyle = '#dbe6f3'; g.font = '600 40px Segoe UI, sans-serif';
    g.fillText(hm(model.t) + ' IST', x, 160);
    g.font = '20px Segoe UI, sans-serif'; g.fillStyle = '#8a9bb3';
    g.fillText(ist(model.t, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), x, 208);

    const slope = model.hourLerp(station.etaObs, model.t + 900) - model.hourLerp(station.etaObs, model.t - 900);
    const rising = slope > 0;
    g.font = '600 24px Segoe UI, sans-serif'; g.fillStyle = rising ? '#3cc6e8' : '#f5a524';
    g.fillText(rising ? 'FLOOD TIDE ↑  water entering' : 'EBB TIDE ↓  water leaving', x, 260);
    const eta = model.eta[station.k];
    g.fillStyle = '#dbe6f3'; g.font = '20px Segoe UI, sans-serif';
    g.fillText(`Sea level at ${station.name}: ${eta >= 0 ? '+' : ''}${eta.toFixed(2)} m`, x, 300);
    g.fillText(`Peak current: ${stats.max.toFixed(2)} m/s (${(stats.max * 1.944).toFixed(1)} kn)`, x, 330);
    g.fillText(`Mean current: ${stats.mean.toFixed(2)} m/s`, x, 360);

    // tide curve over the whole window; the selected cycle is shaded
    const cx = x, cy = 420, cw = W - x - 40, ch = 200;
    g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(cx, cy, cw, ch);
    let lo = Infinity, hi = -Infinity;
    for (let t = t0; t <= t1; t += 600) { const v = model.hourLerp(station.etaObs, t); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const p of series) { lo = Math.min(lo, p.eta); hi = Math.max(hi, p.eta); }
    lo -= 0.3; hi += 0.3;
    const X = (t) => cx + ((t - t0) / (t1 - t0)) * cw, Y = (v) => cy + ch - ((v - lo) / (hi - lo)) * ch;
    g.fillStyle = 'rgba(60,198,232,0.10)'; g.fillRect(X(cyc.tStart), cy, X(cyc.tEnd) - X(cyc.tStart), ch);
    g.strokeStyle = 'rgba(60,198,232,0.35)'; g.setLineDash([3, 4]);
    for (const t of [cyc.tStart, cyc.tEnd]) { g.beginPath(); g.moveTo(X(t), cy); g.lineTo(X(t), cy + ch); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.setLineDash([]); g.beginPath(); g.moveTo(cx, Y(0)); g.lineTo(cx + cw, Y(0)); g.stroke();
    g.strokeStyle = 'rgba(220,230,240,0.55)'; g.lineWidth = 2; g.setLineDash([6, 5]); g.beginPath();
    for (let t = t0; t <= t1; t += 600) { const v = model.hourLerp(station.etaObs, t); t === t0 ? g.moveTo(X(t), Y(v)) : g.lineTo(X(t), Y(v)); }
    g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#3cc6e8'; g.lineWidth = 3; g.beginPath();
    series.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.eta)) : g.moveTo(X(p.t), Y(p.eta))));
    g.stroke(); g.lineWidth = 1;
    const last = series[series.length - 1];
    g.fillStyle = '#ffd43b'; g.beginPath(); g.arc(X(last.t), Y(last.eta), 6, 0, 7); g.fill();
    g.font = '15px Segoe UI, sans-serif'; g.fillStyle = '#8a9bb3';
    g.fillText(`${hi.toFixed(1)} m`, cx + 6, cy + 6); g.fillText(`${lo.toFixed(1)} m`, cx + 6, cy + ch - 22);
    g.fillText(hm(t0), cx, cy + ch + 8);
    const endLbl = hm(t1);
    g.fillText(endLbl, cx + cw - g.measureText(endLbl).width, cy + ch + 8);
    g.fillStyle = 'rgba(60,198,232,0.8)';
    const mid = 'selected cycle', mx = (X(cyc.tStart) + X(cyc.tEnd)) / 2 - g.measureText(mid).width / 2;
    g.fillText(mid, mx, cy + ch + 8);
    g.fillStyle = '#3cc6e8'; g.fillRect(cx, cy + ch + 42, 24, 3); g.fillStyle = '#dbe6f3'; g.fillText('Model', cx + 32, cy + ch + 34);
    g.strokeStyle = 'rgba(220,230,240,0.7)'; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(cx + 110, cy + ch + 43); g.lineTo(cx + 134, cy + ch + 43); g.stroke(); g.setLineDash([]);
    g.fillText('Open-Meteo (real)', cx + 142, cy + ch + 34);

    const L = map.legend();
    if (L) {
      const by = 720;
      g.fillStyle = '#dbe6f3'; g.font = '600 17px Segoe UI, sans-serif'; g.fillText(L.title, x, by);
      const grad = g.createLinearGradient(x, 0, W - 40, 0);
      L.stops.forEach((c, i) => grad.addColorStop(i / (L.stops.length - 1), c));
      g.fillStyle = grad; g.fillRect(x, by + 30, W - x - 40, 16);
      g.fillStyle = '#8a9bb3'; g.font = '15px Segoe UI, sans-serif';
      g.fillText(L.min, x, by + 54); g.fillText(L.max, W - 40 - g.measureText(L.max).width, by + 54);
    }
    g.fillStyle = '#5d6f88'; g.font = '13px Segoe UI, sans-serif';
    g.fillText('2-D shallow-water model · GEBCO bathymetry · tides: Open-Meteo Marine (SMOC)', x, H - 40);
  }

  /* ---------- minimal MP4 (ISO BMFF) writer for one H.264 track, constant frame rate ---------- */
  class Mp4Writer {
    constructor(w, h, fps) { this.w = w; this.h = h; this.fps = fps; this.samples = []; this.keys = []; this.avcC = null; }
    add(chunk, meta) {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.avcC) {
        const d = meta.decoderConfig.description;
        this.avcC = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
      }
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      this.samples.push(buf);
      if (chunk.type === 'key') this.keys.push(this.samples.length);
    }
    finish() {
      const TS = this.fps * 1000, delta = 1000, n = this.samples.length;
      const durMedia = n * delta, durMovie = Math.round((n / this.fps) * 1000);
      const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      const u16 = (v) => [(v >>> 8) & 255, v & 255];
      const str = (s) => [...s].map((c) => c.charCodeAt(0));
      const box = (type, ...parts) => {
        const body = parts.flatMap((p) => (p instanceof Uint8Array ? Array.from(p) : p));
        return [...u32(8 + body.length), ...str(type), ...body];
      };
      const full = (type, ver, flags, ...parts) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
      const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

      const ftyp = box('ftyp', str('isom'), u32(512), str('isomiso2avc1mp41'));
      const dataLen = this.samples.reduce((s, b) => s + b.length, 0);
      const mdatHeader = [...u32(8 + dataLen), ...str('mdat')];

      const build = (chunkOffset) => {
        const avc1 = box('avc1', new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(this.w), u16(this.h),
          u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Array(32).fill(0), u16(0x18), u16(0xffff),
          box('avcC', this.avcC));
        const stbl = box('stbl',
          full('stsd', 0, 0, u32(1), avc1),
          full('stts', 0, 0, u32(1), u32(n), u32(delta)),
          full('stss', 0, 0, u32(this.keys.length), this.keys.flatMap(u32)),
          full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
          full('stsz', 0, 0, u32(0), u32(n), this.samples.flatMap((b) => u32(b.length))),
          full('stco', 0, 0, u32(1), u32(chunkOffset)));
        const minf = box('minf', full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
          box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
        const mdia = box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(durMedia), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler'), [0]),
          minf);
        const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMovie), u32(0), u32(0),
          u16(0), u16(0), u16(0), u16(0), matrix, u32(this.w << 16), u32(this.h << 16));
        const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMovie), u32(0x00010000), u16(0x0100),
          u16(0), u32(0), u32(0), matrix, new Array(24).fill(0), u32(2));
        return box('moov', mvhd, box('trak', tkhd, mdia));
      };
      // moov before mdat (fast start): its size doesn't depend on the offset value, so build twice
      const moovLen = build(0).length;
      const moov = build(ftyp.length + moovLen + mdatHeader.length);
      return new Blob([new Uint8Array(ftyp), new Uint8Array(moov), new Uint8Array(mdatHeader), ...this.samples], { type: 'video/mp4' });
    }
  }

  window.Recorder = { recordCycle, findCycle };
})();
