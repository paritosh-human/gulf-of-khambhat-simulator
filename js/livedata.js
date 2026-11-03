/* Live data refresh from Open-Meteo (same calls as tools/fetch_data.py)
 *
 * LiveData.fetchLatest(baseData) -> Promise<data>   (same shape as window.GULF_DATA)
 * LiveData.fetchWindOnly(data)   -> Promise<bool>   (fills data.wind in place)
 */
(function () {
  'use strict';
  const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const TIMEOUT = 30000;
  const WIND_POINT = { lat: 21.3, lon: 72.3 };

  async function getJSON(url, tries = 1) {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || body.error) throw new Error((body && body.reason) || 'HTTP ' + r.status);
        return body;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error('timeout after ' + TIMEOUT / 1000 + ' s') : e;
      } finally {
        clearTimeout(timer);
      }
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
    throw lastErr;
  }

  /** one request for many points; Open-Meteo returns an array when lat/lon are comma lists */
  async function marine(points) {
    const url = MARINE + '?latitude=' + points.map((p) => p.lat).join(',') + '&longitude=' + points.map((p) => p.lon).join(',') +
      '&hourly=sea_level_height_msl,ocean_current_velocity,ocean_current_direction&past_days=30&forecast_days=1&timezone=GMT';
    const d = await getJSON(url, 2);
    const arr = Array.isArray(d) ? d : [d];
    if (arr.length !== points.length) throw new Error('marine API returned ' + arr.length + ' locations, expected ' + points.length);
    return arr;
  }

  async function windRaw() {
    const url = FORECAST + '?latitude=' + WIND_POINT.lat + '&longitude=' + WIND_POINT.lon +
      '&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&past_days=30&forecast_days=1&timezone=GMT';
    const d = await getJSON(url, 3);
    return Array.isArray(d) ? d[0] : d;
  }

  /** expected hourly time strings ("YYYY-MM-DDTHH:MM", GMT) for data.time0 / data.hours */
  function timeAxis(time0, hours) {
    const t0 = Date.parse(time0), out = new Array(hours);
    for (let i = 0; i < hours; i++) out[i] = new Date(t0 + i * 3600e3).toISOString().slice(0, 16);
    return out;
  }

  /** map wind hourly arrays onto `times` (matching by timestamp), gaps forward/back-filled, else 0 */
  function alignWind(w, times) {
    const hz = (w && w.hourly) || {};
    const wt = hz.time || [], sp = hz.wind_speed_10m || [], dr = hz.wind_direction_10m || [];
    const idx = new Map();
    wt.forEach((t, i) => idx.set(t, i));
    const speed = new Array(times.length).fill(null), dir = new Array(times.length).fill(null);
    let hits = 0;
    times.forEach((t, i) => {
      const k = idx.get(t);
      if (k !== undefined && sp[k] != null) { speed[i] = sp[k]; dir[i] = dr[k]; hits++; }
    });
    if (!hits) throw new Error('wind series does not overlap the tide period');
    fill(speed); fill(dir);
    return { speed, dir };
  }
  function fill(a) {
    let last = null;
    for (let i = 0; i < a.length; i++) if (a[i] == null) a[i] = last; else last = a[i];
    last = null;
    for (let i = a.length - 1; i >= 0; i--) if (a[i] == null) a[i] = last; else last = a[i];
    for (let i = 0; i < a.length; i++) if (a[i] == null) a[i] = 0;
  }

  function stamp() {
    const d = new Date(), p = (n) => (n < 10 ? '0' : '') + n;
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }

  async function fetchLatest(baseData) {
    const bPts = baseData.boundary.map((b) => ({ lat: b.lat, lon: b.lon }));
    const sPts = baseData.stations.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon }));
    const [b, s] = await Promise.all([marine(bPts), marine(sPts)]);
    const times = b[0].hourly.time;
    const hours = times.length;
    const fit = (arr) => {
      const a = (arr || []).slice(0, hours);
      while (a.length < hours) a.push(null);
      return a;
    };
    const data = {
      source: Object.assign({}, baseData.source, {
        tides: 'Open-Meteo Marine API (sea_level_height_msl, Meteo-France SMOC)',
        wind: 'Open-Meteo Forecast API (10 m wind)',
        fetched: stamp(),
        live: true,
      }),
      grid: baseData.grid,
      time0: times[0] + 'Z',
      hours,
      boundary: bPts.map((p, i) => ({ lat: p.lat, lon: p.lon, eta: fit(b[i].hourly.sea_level_height_msl) })),
      stations: sPts.map((p, i) => ({
        name: p.name, lat: p.lat, lon: p.lon,
        eta: fit(s[i].hourly.sea_level_height_msl),
        cur: fit(s[i].hourly.ocean_current_velocity),
        dir: fit(s[i].hourly.ocean_current_direction),
      })),
      wind: { speed: new Array(hours).fill(0), dir: new Array(hours).fill(0) },
    };
    delete data.source.windError;
    // sea level must exist at at least one boundary point, otherwise the model has no forcing
    if (!data.boundary.some((p) => p.eta.some((v) => v != null))) throw new Error('no sea-level data at the open boundary');
    await fetchWindOnly(data);
    return data;
  }

  async function fetchWindOnly(data) {
    try {
      const w = await windRaw();
      data.wind = alignWind(w, timeAxis(data.time0, data.hours));
      if (data.source) delete data.source.windError;
      return true;
    } catch (e) {
      if (!data.wind || !data.wind.speed || data.wind.speed.length !== data.hours) {
        data.wind = { speed: new Array(data.hours).fill(0), dir: new Array(data.hours).fill(0) };
      }
      data.source = data.source || {};
      data.source.windError = String((e && e.message) || e);
      return false;
    }
  }

  window.LiveData = { fetchLatest, fetchWindOnly };
})();
