# Gulf of Khambhat — Tide & Pollution Simulator

Interactive browser simulator of tidal flow and contaminant spreading in the Gulf of Khambhat (Cambay), driven by real data from the last 30 days.

## Run

```bash
python -m http.server 8765
```
Then open http://localhost:8765. Opening `index.html` directly also works.

## Real data used
| What | Source | How |
|---|---|---|
| Bathymetry / coastline | GEBCO 2020 (15″) via api.opentopodata.org | baked into `data/gulf_data.js` (2 km grid, 111×114) |
| Sea level, 30 days hourly | Open-Meteo Marine API `sea_level_height_msl` (Météo-France SMOC, includes tides) | 8 open-sea boundary points force the model; 7 ports used for validation |
| 10 m wind | Open-Meteo Forecast API | optional forcing (falls back to calm if the API is down) |

Refresh the bundled data with `python -I tools/fetch_data.py`, or click **Fetch latest 30 days** in the app (fetches live from the browser).

## Model
- 2-D depth-averaged shallow-water equations, C-grid, Δt ≈ 33 s, with wetting/drying of tidal flats, Coriolis, quadratic friction, nonlinear advection (this produces the residual eddies) and wind stress.
- Tracers: toxic (conservative), organic (first-order decay), and **water age** (days since the water left the open sea, which shows where it gets trapped).
- Lagrangian drifters with trails show the tidal loops; plume and oil particles (oil has 3 % windage).
- Residual currents are averaged over 2 M2 cycles (24.84 h); the "Residual eddies" layer shows their vorticity.
- Validation: `tools/test_model.html` runs 3 days headless and compares the tidal range with Open-Meteo at each port. At the mouth the match is within ~0.1 m. Inside the gulf the model reaches ~75 % of the amplification (use the *Tide amplitude* slider to calibrate).

Industry loads in "Load real clusters" are **illustrative**, not measured discharges.

## Files
`js/model.js` model · `js/render.js` + `js/colormaps.js` map · `js/chart.js` timeline chart · `js/livedata.js` Open-Meteo fetch · `js/app.js` UI · `docs/ARCHITECTURE.md` interfaces.
