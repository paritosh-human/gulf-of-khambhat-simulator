/* Colour maps for the Gulf of Khambhat simulator.
 *
 *   Colormaps.get(name)        -> (t in 0..1) => [r, g, b]   (0..255 ints)
 *   Colormaps.lut(name, n=256) -> Uint8ClampedArray(n*3)      (cached, for per-pixel loops)
 *   Colormaps.css(name, t, a)  -> 'rgb(...)' / 'rgba(...)' string
 *   Colormaps.names            -> ['speed','diverging','contaminant','age','depth']
 *
 * Maps:
 *   speed       perceptual, dark indigo -> teal -> green -> yellow (viridis-like, brightened low end)
 *   diverging   light blue -> blue -> dark slate -> red -> light orange; t = 0.5 is zero
 *   contaminant yellow-green -> yellow -> orange -> red -> magenta (log concentration)
 *   age         plasma-like: indigo -> purple -> pink -> orange -> yellow
 *   depth       t = 0 shallow (teal) -> t = 1 deep (navy); used for the base map
 */
(function () {
  'use strict';

  const STOPS = {
    speed: [
      [0.0, [40, 22, 92]],
      [0.15, [58, 64, 150]],
      [0.32, [38, 120, 160]],
      [0.5, [30, 165, 140]],
      [0.68, [92, 200, 92]],
      [0.85, [200, 222, 52]],
      [1.0, [253, 240, 120]],
    ],
    // dark-centred diverging map (reads well on a dark UI; zero = deep slate, extremes bright)
    diverging: [
      [0.0, [160, 222, 255]],
      [0.17, [76, 156, 236]],
      [0.35, [40, 82, 150]],
      [0.5, [32, 36, 46]],
      [0.65, [140, 52, 46]],
      [0.83, [226, 108, 62]],
      [1.0, [255, 210, 140]],
    ],
    contaminant: [
      [0.0, [118, 178, 72]],
      [0.22, [214, 214, 64]],
      [0.45, [248, 168, 48]],
      [0.68, [236, 82, 42]],
      [0.86, [190, 28, 74]],
      [1.0, [140, 16, 120]],
    ],
    age: [
      [0.0, [13, 8, 135]],
      [0.25, [126, 3, 168]],
      [0.5, [204, 71, 120]],
      [0.75, [248, 149, 64]],
      [1.0, [240, 249, 33]],
    ],
    depth: [
      [0.0, [44, 132, 138]],
      [0.12, [34, 110, 128]],
      [0.3, [26, 84, 116]],
      [0.55, [18, 58, 98]],
      [0.8, [12, 38, 76]],
      [1.0, [8, 24, 56]],
    ],
  };

  function make(stops) {
    const n = stops.length;
    return function (t) {
      if (!(t > 0)) t = 0; else if (t > 1) t = 1; // also maps NaN -> 0
      let i = 1;
      while (i < n - 1 && stops[i][0] < t) i++;
      const a = stops[i - 1], b = stops[i];
      const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
      const ca = a[1], cb = b[1];
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * f),
        Math.round(ca[1] + (cb[1] - ca[1]) * f),
        Math.round(ca[2] + (cb[2] - ca[2]) * f),
      ];
    };
  }

  const fns = {};
  for (const k in STOPS) fns[k] = make(STOPS[k]);
  const lutCache = {};

  const Colormaps = {
    names: Object.keys(STOPS),
    get(name) {
      return fns[name] || fns.speed;
    },
    lut(name, n) {
      n = n || 256;
      const key = name + ':' + n;
      if (lutCache[key]) return lutCache[key];
      const f = this.get(name), out = new Uint8ClampedArray(n * 3);
      for (let i = 0; i < n; i++) {
        const c = f(i / (n - 1));
        out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
      }
      return (lutCache[key] = out);
    },
    css(name, t, a) {
      const c = this.get(name)(t);
      return a == null ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    },
  };

  window.Colormaps = Colormaps;
})();
