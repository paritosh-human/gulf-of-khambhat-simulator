/* App controller: wires the model, map renderer, chart and sidebar UI together. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HOUR = 3600, DAY = 86400;

  const TYPES = {
    chemical: { label: 'Chemical / pharma', mix: { toxic: 0.8, organic: 0.2, oil: 0.0, color: '#ef5d6c' } },
    petro: { label: 'Petrochemical / refinery', mix: { toxic: 0.5, organic: 0.5, oil: 0.35, color: '#f5a524' } },
    textile: { label: 'Textile & dyes', mix: { toxic: 0.4, organic: 0.6, oil: 0.0, color: '#c77dff' } },
    shipbreak: { label: 'Ship-breaking yard', mix: { toxic: 0.7, organic: 0.3, oil: 0.5, color: '#9aa5b1' } },
    sewage: { label: 'Municipal sewage', mix: { toxic: 0.05, organic: 0.95, oil: 0.0, color: '#b08850' } },
    power: { label: 'Thermal power / ash', mix: { toxic: 0.35, organic: 0.65, oil: 0.0, color: '#ffd43b' } },
  };
  // real industrial clusters discharging (directly or via rivers) into the gulf; loads are illustrative
  const PRESETS = [
    { name: 'Alang-Sosiya ship-breaking', type: 'shipbreak', lat: 21.40, lon: 72.20, rate: 3000 },
    { name: 'Dahej PCPIR / SEZ', type: 'chemical', lat: 21.68, lon: 72.55, rate: 8000 },
    { name: 'Ankleshwar–Bharuch (Narmada)', type: 'chemical', lat: 21.63, lon: 72.66, rate: 10000 },
    { name: 'Hazira industrial area', type: 'petro', lat: 21.09, lon: 72.62, rate: 6000 },
    { name: 'Surat textiles (Tapi)', type: 'textile', lat: 21.06, lon: 72.68, rate: 5000 },
    { name: 'Sabarmati (Ahmedabad effluent)', type: 'sewage', lat: 22.25, lon: 72.40, rate: 12000 },
    { name: 'Mahi (Vadodara / Nandesari)', type: 'chemical', lat: 22.20, lon: 72.57, rate: 4000 },
    { name: 'Bhavnagar creek', type: 'sewage', lat: 21.76, lon: 72.23, rate: 2000 },
    { name: 'Pipavav port', type: 'petro', lat: 20.93, lon: 71.53, rate: 800 },
  ];

  let data = window.GULF_DATA;
  const model = new GulfModel(data);
  const map = new MapRenderer($('map'), model);
  const chart = new TideChart($('chart'), model);

  const ui = {
    playing: false, speed: 3600, mode: 'pan', selectedIndustryId: null, probe: null, hover: null, placing: null,
    stationIndex: 0, newType: 'chemical', newRate: 3000, newMode: 'continuous', spillTonnes: 50, spillType: 'petro', drifterCount: 16,
  };

  /* ---------------- time helpers ---------------- */
  const fmtIST = (t, opts) => new Date(model.time0 + t * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
  function updateClock() {
    const t = Math.max(model.t, 0);
    $('clockDate').textContent = fmtIST(t, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';
    const s = model.stations[ui.stationIndex];
    let tide = '';
    if (s && s.k >= 0) {
      const e = model.eta[s.k], hr = t / HOUR;
      const obs = model.hourLerp(s.etaObs, t);
      const slope = model.hourLerp(s.etaObs, t + 1800) - model.hourLerp(s.etaObs, t - 1800);
      tide = `${s.name}: ${e >= 0 ? '+' : ''}${e.toFixed(2)} m model · ${obs >= 0 ? '+' : ''}${obs.toFixed(2)} m real · ${slope > 0 ? 'flooding ↑' : 'ebbing ↓'}`;
      void hr;
    }
    $('clockTide').textContent = model.spinningUp ? 'spinning up hydrodynamics…' : tide;
  }

  /* ---------------- simulation loop ---------------- */
  let last = performance.now(), frame = 0, stepsLastSec = 0, stepAcc = 0, perfT = last, debt = 0;
  function loop(now) {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    if (model.spinningUp) {
      while (model.spinningUp && performance.now() - t0 < 30) { model.step(); stepAcc++; }
      const spinLen = model.targetT - model.tRamp;
      $('spinner').hidden = false;
      $('spinText').textContent = `Spinning up tides… ${Math.round(100 * (1 - (model.targetT - model.t) / Math.max(1, spinLen)))}%`;
      if (!model.spinningUp) { $('spinner').hidden = true; map.invalidateTrails(); }
    } else if (ui.playing) {
      debt += ui.speed * realDt;
      const budget = 24;
      while (debt >= model.dt && performance.now() - t0 < budget) {
        model.step(); stepAcc++; debt -= model.dt;
        if (model.t >= model.tEnd) { setPlaying(false); debt = 0; break; }
      }
      if (debt > ui.speed) debt = ui.speed; // can't keep up: drop time rather than spiral
    }
    map.draw(ui);
    if (frame % 4 === 0) chart.draw({ stationIndex: ui.stationIndex, tNow: Math.max(0, model.t) });
    if (frame % 10 === 0) { updateClock(); updateStats(); updateHover(); }
    if (now - perfT > 1000) {
      stepsLastSec = stepAcc; stepAcc = 0; perfT = now;
      const simRate = (stepsLastSec * model.dt) / HOUR;
      $('perf').textContent = `${stepsLastSec} steps/s · ${simRate.toFixed(1)} sim-h/s · Δt ${model.dt}s · ${model.particles.count} particles`;
    }
    frame++;
    requestAnimationFrame(loop);
  }

  function setPlaying(p) {
    ui.playing = p;
    $('btnPlay').textContent = p ? '❚❚' : '▶';
  }

  function jumpTo(t) {
    t = Math.max(6 * HOUR, Math.min(model.tEnd - HOUR, t));
    model.reset(t, true, Math.min(18 * HOUR, t));
    map.invalidateTrails();
    debt = 0;
  }

  /* ---------------- stats & hover ---------------- */
  const fmtMass = (g) => (g > 1e9 ? (g / 1e9).toFixed(2) + ' kt' : g > 1e6 ? (g / 1e6).toFixed(1) + ' t' : (g / 1e3).toFixed(0) + ' kg');
  function updateStats() {
    const s = model.summary(), st = model.stats;
    const emitted = st.emittedToxic + st.emittedOrganic;
    const inGulf = s.massToxic + s.massOrganic;
    const flushed = st.flushedToxic + st.flushedOrganic;
    const drifters = model.particles.countKind(GulfModel.KIND.DRIFTER);
    $('stats').innerHTML = `
      <div><span class="muted">Released</span><b>${fmtMass(emitted)}</b></div>
      <div><span class="muted">Still in gulf</span><b>${fmtMass(inGulf)}</b></div>
      <div><span class="muted">Flushed to sea</span><b>${fmtMass(flushed)}</b></div>
      <div><span class="muted">Degraded</span><b>${fmtMass(st.decayed)}</b></div>
      <div><span class="muted">Area &gt; 0.01 mg/L</span><b>${s.pollutedArea.toFixed(0)} km²</b></div>
      <div><span class="muted">Peak conc.</span><b>${s.cmax.toFixed(3)} mg/L</b></div>
      <div><span class="muted">Wet area</span><b>${s.wetArea.toFixed(0)} km²</b></div>
      <div><span class="muted">Mean water age</span><b>${s.meanAge.toFixed(1)} d</b></div>
      ${drifters ? `<div><span class="muted">Drifters afloat</span><b>${drifters}</b></div>` : ''}`;
    const L = map.legend();
    if (L) {
      $('legend').style.display = '';
      $('legend').innerHTML = `<div class="title">${L.title}</div>
        <div class="bar" style="background:linear-gradient(90deg,${L.stops.join(',')})"></div>
        <div class="ends"><span>${L.min}</span><span>${L.max}</span></div>`;
    } else $('legend').style.display = 'none';
  }

  function updateHover() {
    if (!ui.hover) { $('hover').innerHTML = ''; return; }
    const { gx, gy } = ui.hover;
    const i = Math.round(gx), j = Math.round(gy);
    if (i < 0 || j < 0 || i >= model.nx || j >= model.ny) { $('hover').innerHTML = ''; return; }
    const k = j * model.nx + i;
    const lon = model.lon0 + gx * model.d, lat = model.lat0 + gy * model.d;
    let html = `<div class="muted">${lat.toFixed(3)}°N ${lon.toFixed(3)}°E</div>`;
    if (!model.mask[k]) html += `<div>Land · ${model.elev[k]} m</div>`;
    else {
      const H = model.eta[k] + model.h[k];
      const [uc, vc] = [model.sampleU(i, j, model.u), model.sampleV(i, j, model.v)];
      const sp = Math.hypot(uc, vc), dir = (Math.atan2(uc, vc) * 180) / Math.PI;
      html += `<div>Depth ${model.h[k].toFixed(1)} m · level ${model.eta[k] >= 0 ? '+' : ''}${model.eta[k].toFixed(2)} m</div>`;
      html += H < GulfModel.HDRY ? '<div class="muted">dry tidal flat</div>'
        : `<div>Current ${sp.toFixed(2)} m/s → ${((dir + 360) % 360).toFixed(0)}°</div>
           <div>Contaminant ${(model.toxic[k] + model.organic[k]).toFixed(4)} mg/L</div>
           <div>Water age ${model.age[k].toFixed(1)} d</div>`;
    }
    $('hover').innerHTML = html;
  }

  /* ---------------- industries UI ---------------- */
  function newIndustry(p) {
    const ind = model.addIndustry({
      name: p.name, type: p.type, lon: p.lon, lat: p.lat, rate: p.rate, mode: p.mode || 'continuous', on: true,
      mix: { ...TYPES[p.type].mix },
    });
    if (ind.k < 0) { model.removeIndustry(ind.id); return null; }
    return ind;
  }
  function renderIndustryList() {
    const list = $('industryList');
    $('indCount').textContent = model.industries.length;
    list.innerHTML = '';
    if (!model.industries.length) {
      list.innerHTML = '<div class="small muted">No industries yet. Use the 🏭 tool to place an outfall, or load the real clusters.</div>';
      return;
    }
    for (const ind of model.industries) {
      const el = document.createElement('div');
      el.className = 'ind' + (ind.id === ui.selectedIndustryId ? ' sel' : '');
      el.style.setProperty('--c', ind.mix.color);
      el.innerHTML = `
        <div class="top"><input type="checkbox" class="on" ${ind.on ? 'checked' : ''} title="Discharging">
          <input class="name" value="${ind.name.replace(/"/g, '&quot;')}"><button class="x" title="Remove">✕</button></div>
        <div class="grid2">
          <select class="type">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${k === ind.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
          <select class="mode">
            <option value="continuous" ${ind.mode === 'continuous' ? 'selected' : ''}>Continuous</option>
            <option value="ebb" ${ind.mode === 'ebb' ? 'selected' : ''}>Ebb tide only</option>
            <option value="flood" ${ind.mode === 'flood' ? 'selected' : ''}>Flood tide only</option>
          </select>
        </div>
        <div class="rate"><input type="range" class="r" min="2" max="4.7" step="0.01" value="${Math.log10(ind.rate)}"><span>${fmtRate(ind.rate)}</span></div>`;
      el.querySelector('.on').onchange = (e) => { ind.on = e.target.checked; };
      el.querySelector('.name').onchange = (e) => { ind.name = e.target.value; };
      el.querySelector('.x').onclick = () => { model.removeIndustry(ind.id); renderIndustryList(); };
      el.querySelector('.type').onchange = (e) => { ind.type = e.target.value; ind.mix = { ...TYPES[ind.type].mix }; renderIndustryList(); };
      el.querySelector('.mode').onchange = (e) => { ind.mode = e.target.value; };
      el.querySelector('.r').oninput = (e) => { ind.rate = Math.round(10 ** +e.target.value); el.querySelector('.rate span').textContent = fmtRate(ind.rate); };
      el.onclick = (e) => { if (e.target === el || e.target.classList.contains('top')) selectIndustry(ind.id, true); };
      list.appendChild(el);
    }
  }
  const fmtRate = (r) => (r >= 1000 ? (r / 1000).toFixed(r >= 10000 ? 0 : 1) + ' t/day' : r + ' kg/day');
  function selectIndustry(id, center) {
    ui.selectedIndustryId = id;
    renderIndustryList();
    const ind = model.industries.find((i) => i.id === id);
    if (ind && center) {
      const el = [...$('industryList').children][model.industries.indexOf(ind)];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------------- tool options ---------------- */
  function renderToolOptions() {
    const box = $('toolOptions');
    const typeSel = (val) => `<select class="tsel">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`;
    const hints = {
      pan: 'Drag to pan · wheel to zoom · drag an industry to move it · click a ◆ station to chart it',
      industry: 'Click on the water to place an outfall (snaps to nearest ≥2 m deep cell)',
      drifter: 'Click to release drifters – watch their trails loop with the tide',
      spill: 'Click to dump an instantaneous spill',
      probe: 'Click to monitor contaminant concentration at a point (bottom chart)',
    };
    $('hint').textContent = ui.mode === 'pan' ? '' : hints[ui.mode];
    $('map').classList.toggle('crosshair', ui.mode !== 'pan');
    ui.placing = ui.mode === 'pan' ? null : { type: ui.mode };
    if (ui.mode === 'industry') {
      box.innerHTML = `<label>Type ${typeSel(ui.newType)}</label>
        <label>Load <input type="range" class="r" min="2" max="4.7" step="0.01" value="${Math.log10(ui.newRate)}"></label>
        <div class="small muted" style="text-align:right" id="newRateLbl">${fmtRate(ui.newRate)}</div>
        <label>Discharge <select class="msel"><option value="continuous">Continuous</option><option value="ebb">Ebb tide only</option><option value="flood">Flood tide only</option></select></label>`;
      box.querySelector('.tsel').onchange = (e) => { ui.newType = e.target.value; };
      box.querySelector('.r').oninput = (e) => { ui.newRate = Math.round(10 ** +e.target.value); $('newRateLbl').textContent = fmtRate(ui.newRate); };
      box.querySelector('.msel').value = ui.newMode;
      box.querySelector('.msel').onchange = (e) => { ui.newMode = e.target.value; };
    } else if (ui.mode === 'spill') {
      box.innerHTML = `<label>Pollutant ${typeSel(ui.spillType)}</label>
        <label>Amount <input type="range" class="s" min="1" max="1000" step="1" value="${ui.spillTonnes}"></label>
        <div class="small muted" style="text-align:right" id="spillLbl">${ui.spillTonnes} tonnes</div>`;
      box.querySelector('.tsel').onchange = (e) => { ui.spillType = e.target.value; };
      box.querySelector('.s').oninput = (e) => { ui.spillTonnes = +e.target.value; $('spillLbl').textContent = ui.spillTonnes + ' tonnes'; };
    } else if (ui.mode === 'drifter') {
      box.innerHTML = `<label>Per click <input type="range" class="d" min="1" max="40" step="1" value="${ui.drifterCount}"></label>
        <div class="small muted" style="text-align:right" id="drLbl">${ui.drifterCount} drifters</div>`;
      box.querySelector('.d').oninput = (e) => { ui.drifterCount = +e.target.value; $('drLbl').textContent = ui.drifterCount + ' drifters'; };
    } else box.innerHTML = '';
  }

  /* ---------------- map interaction ---------------- */
  const canvas = $('map');
  let drag = null;
  const rel = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = rel(e);
    canvas.setPointerCapture(e.pointerId);
    const ind = ui.mode === 'pan' ? map.hitIndustry(sx, sy) : null;
    drag = { sx, sy, lx: sx, ly: sy, moved: false, ind };
  });
  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = rel(e);
    const [gx, gy] = map.screenToGrid(sx, sy);
    ui.hover = { gx, gy };
    if (!drag) return;
    if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.ind) {
      drag.ind.lon = model.lon0 + gx * model.d; drag.ind.lat = model.lat0 + gy * model.d; // follows cursor; snapped on release
    } else {
      map.panBy(sx - drag.lx, sy - drag.ly);
      canvas.classList.add('dragging');
    }
    drag.lx = sx; drag.ly = sy;
  });
  canvas.addEventListener('pointerleave', () => { ui.hover = null; });
  canvas.addEventListener('pointerup', (e) => {
    const [sx, sy] = rel(e);
    canvas.classList.remove('dragging');
    const d = drag; drag = null;
    if (!d) return;
    if (d.moved) {
      if (d.ind) { model.moveIndustry(d.ind, d.ind.lon, d.ind.lat); selectIndustry(d.ind.id); }
      else map.invalidateTrails();
      return;
    }
    onClick(sx, sy);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = rel(e);
    map.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
    map.invalidateTrails();
  }, { passive: false });

  function onClick(sx, sy) {
    const [gx, gy] = map.screenToGrid(sx, sy);
    const lon = model.lon0 + gx * model.d, lat = model.lat0 + gy * model.d;
    if (ui.mode === 'pan') {
      const ind = map.hitIndustry(sx, sy);
      if (ind) { selectIndustry(ind.id, true); return; }
      const st = map.hitStation(sx, sy);
      if (st) { ui.stationIndex = model.stations.indexOf(st); $('stationSel').value = ui.stationIndex; return; }
      selectIndustry(null);
    } else if (ui.mode === 'industry') {
      const n = model.industries.length + 1;
      const ind = newIndustry({ name: `${TYPES[ui.newType].label.split(' ')[0]} plant ${n}`, type: ui.newType, lon, lat, rate: ui.newRate, mode: ui.newMode });
      if (ind) selectIndustry(ind.id, true);
    } else if (ui.mode === 'drifter') {
      model.addDrifters(gx, gy, ui.drifterCount, ui.drifterCount > 1 ? 1.2 : 0);
    } else if (ui.mode === 'spill') {
      model.spill(lon, lat, ui.spillTonnes, TYPES[ui.spillType].mix);
    } else if (ui.mode === 'probe') {
      const k = model.nearestWet(lon, lat, 0.5);
      if (k >= 0) { model.setProbe(k); ui.probe = { gx: k % model.nx, gy: (k / model.nx) | 0 }; }
    }
  }

  /* ---------------- controls ---------------- */
  function bind() {
    $('btnPlay').onclick = () => setPlaying(!ui.playing);
    $('btnRestart').onclick = () => { model.clearPollution(); model.clearDrifters(); for (const s of model.stations) s.etaModel.fill(NaN); jumpTo(DAY); };
    $('speed').onchange = (e) => { ui.speed = +e.target.value; };
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!ui.playing); }
    });
    $('tools').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      ui.mode = b.dataset.mode;
      for (const x of $('tools').children) x.classList.toggle('active', x === b);
      renderToolOptions();
    });
    for (const r of document.querySelectorAll('input[name=layer]')) r.onchange = () => { map.layer = r.value; updateStats(); };
    const chk = { showParticles: 'particles', showArrows: 'arrows', showResidualArrows: 'residualArrows', showDrifters: 'drifters', showPlume: 'plume', showLabels: 'labels', showStations: 'stations' };
    for (const [id, key] of Object.entries(chk)) { $(id).checked = map.show[key] = $(id).checked; $(id).onchange = (e) => { map.show[key] = e.target.checked; map.invalidateTrails(); }; }
    $('flowSource').onchange = (e) => { map.flowSource = e.target.value; map.invalidateTrails(); };
    const P = model.params;
    $('amp').oninput = (e) => { P.ampScale = +e.target.value; $('ampVal').textContent = P.ampScale.toFixed(2); };
    $('fric').oninput = (e) => { P.friction = +e.target.value; $('fricVal').textContent = P.friction.toFixed(4); };
    $('halflife').oninput = (e) => { P.organicHalfLife = +e.target.value; $('hlVal').textContent = P.organicHalfLife.toFixed(2); };
    $('windScale').oninput = (e) => { P.windScale = +e.target.value; $('windVal').textContent = P.windScale.toFixed(1); };
    $('advection').onchange = (e) => { P.advection = e.target.checked; };
    $('wind').onchange = (e) => { P.wind = e.target.checked; };
    $('btnPresets').onclick = () => {
      for (const p of PRESETS) if (!model.industries.some((i) => i.name === p.name)) newIndustry(p);
      renderIndustryList();
    };
    $('btnClearInd').onclick = () => { model.industries = []; ui.selectedIndustryId = null; renderIndustryList(); };
    $('btnSeedGrid').onclick = () => model.seedDrifterGrid(5);
    $('btnClearDrifters').onclick = () => model.clearDrifters();
    $('btnClearPollution').onclick = () => model.clearPollution();
    $('stationSel').innerHTML = model.stations.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
    $('stationSel').onchange = (e) => { ui.stationIndex = +e.target.value; };
    chart.onSeek = (t) => jumpTo(t);
    $('btnFetch').onclick = fetchLatest;
    window.addEventListener('resize', () => { map.resize(); chart.resize && chart.resize(); });
  }

  function renderDataInfo() {
    const s = data.source;
    const t0 = new Date(Date.parse(data.time0)), t1 = new Date(Date.parse(data.time0) + (data.hours - 1) * HOUR * 1000);
    const f = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    const windOk = data.wind.speed.some((x) => x > 0);
    $('dataInfo').innerHTML = `
      <div><b>Period</b> ${f(t0)} – ${f(t1)} (${data.hours} h)</div>
      <div><b>Tides</b> ${s.tides}</div>
      <div><b>Bathymetry</b> ${s.bathymetry}</div>
      <div><b>Wind</b> ${windOk ? s.wind : '<span style="color:var(--accent2)">unavailable – calm assumed</span>'}</div>
      <div class="muted">Fetched ${s.fetched}</div>`;
  }

  async function fetchLatest() {
    $('fetchStatus').textContent = 'Downloading from Open-Meteo…';
    $('btnFetch').disabled = true;
    try {
      const nd = await LiveData.fetchLatest(data);
      data = nd;
      model.setForcing(nd);
      model.clearPollution(); model.clearDrifters();
      jumpTo(DAY);
      renderDataInfo();
      $('fetchStatus').textContent = 'Updated ✓' + (nd.source.windError ? ' (wind unavailable)' : '');
    } catch (err) {
      $('fetchStatus').textContent = 'Fetch failed – using bundled data (' + err.message + ')';
    } finally { $('btnFetch').disabled = false; }
  }

  // try to fill in wind if the bundled data has none (Open-Meteo forecast API was overloaded at bake time)
  async function maybeFetchWind() {
    if (data.wind.speed.some((x) => x > 0)) return;
    try {
      if (await LiveData.fetchWindOnly(data)) { model.setForcing(data); renderDataInfo(); }
    } catch (e) { /* stay calm */ }
  }

  bind();
  renderToolOptions();
  renderIndustryList();
  renderDataInfo();
  jumpTo(DAY);
  setPlaying(true);
  requestAnimationFrame(loop);
  maybeFetchWind();
  window.app = { model, map, chart, ui, jumpTo };
})();
