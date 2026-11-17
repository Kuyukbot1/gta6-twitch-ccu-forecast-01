// gta6-twitch-ccu-forecast-01: forecast GTA VI's launch-day Twitch viewers, hour by
// hour, from the first hour's print. Node 22, standard library only, deterministic.
//
// Model (fitted at run time from the case file's own comparables, nothing else):
//
//   Launch days do NOT look like a single midnight spike. A console game unlocks at
//   midnight local time, region by region, so the UTC day holds several waves: the
//   UK unlock at 00:00Z (hour 1), the US east coast at 05:00Z (hour 6), the US west
//   coast at 08:00Z (hour 9), then the evening prime time in Europe and the US
//   through hours 15-22. PC-simultaneous launches look nothing like this (their
//   global PC unlock puts the peak in hour 1), so they are left out of the pool.
//
//   1. Pool: the case's comparables whose tier is "comparable" (parsed from the
//      unlock note), whose platforms list no PC (console-only rolling unlock),
//      whose release-day curve is complete (all 24 UTC hours present, every hour
//      at least 1 viewer), and whose hour-1 print is at least 1000 viewers
//      (smaller prints make ratios meaningless). In a practice case that is 7
//      launches; in the final it is 11 (the four practice launches join).
//   2. Shape: for each hour h, the median across the pool of log(viewers_h /
//      viewers_1). Hours 2-8 keep this median as-is.
//   3. Rise-vs-midnight effect: for hours 9-24 the log-ratio correlates about
//      -0.7 to -0.86 with log(hour-1) across launches (slope about -0.3): a
//      launch whose midnight hour is already huge has less headroom left to
//      rise, and one whose midnight hour is small rises several-fold. So for
//      hours 9-24 the median is adjusted by a pooled regression: one slope
//      beta, fitted by least squares on the per-hour-demeaned log-ratios of
//      the pool, times (log(p1) - mean log(hour-1) of the pool). The intercept
//      per hour is the median of the regression residuals.
//   4. Spread: per hour, sigma is the interquartile range of the residuals
//      (hours 2-8: of the log-ratios) divided by 1.349, floored at 0.10 log
//      units and scaled by 1.4. The 1.4 was chosen because both the practice
//      cases and leave-one-out over the pool score best at a spread about
//      1.2-1.6x the raw IQR (wider is no better past 1.4, narrower is worse).
//      Quantiles are q_tau = p1 * exp(median + z_tau * sigma).
//   5. If fewer than 3 launches qualify for the pool, the entry falls back to
//      the house persistence forecast (flat at hour 1, lognormal spread
//      0.15/sqrt-hour), so it still answers instead of failing.
//
// Validation (practice answers fetched once from SullyGnome's public chart
// API, the source the kit's NOTICE.txt names; the case files hold no answers):
// mean pinball loss over p00-p03 is 0.19 against 0.39 for persistence:
//   p00 Wolverine     0.359 vs 0.744   p01 RDR2          0.149 vs 0.287
//   p02 GoW Ragnarok  0.097 vs 0.215   p03 Spider-Man 2  0.160 vs 0.303
// Leave-one-out over the 7 pool launches: 6 of 7 beat persistence
// (mean 0.160 vs 0.344). See BUILD_LOG.md.
//
// Rejected after testing: a second regressor, log(channels/viewers at hour 1),
// correlates 0.78 with the peak ratio, but it is collinear with log(hour-1) and
// overfits: practice mean 0.188 vs 0.191, yet leave-one-out 0.177 vs 0.160
// (FF7 Rebirth blows up to 0.357). One slope only. A pre-release-baseline
// predictor was also tested and dropped: the baseline is unreliable for small
// categories (SullyGnome samples them only about every 12 h) and adds nothing
// once log(hour-1) is in. Smoothing the per-hour medians/sigmas across
// neighbouring hours was tested too and changed nothing (0.194 vs 0.194).
//
// Deterministic: pure functions of the input file only. No Date, no
// Math.random, no network. Comparables are sorted by name before fitting so
// every run takes the same path through the same numbers; two runs of one
// case write byte-identical output.
//
// Input: every <id>.in in MAKEFUN_INPUT_DIR (/input), one case per file.
// Output: <id>.out in MAKEFUN_OUTPUT_DIR (/output):
//   {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}, hours 2..24,
//   each q finite, above 0, at most 1e9, non-decreasing.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** First hour the midnight-rise regression applies to (hours 2-8 show no relation). */
const REG_FROM = 9;
/** Smallest hour-1 print a comparable may have and still join the pool. */
const MIN_POOL_H1 = 1000;
/** Smallest per-hour log spread, in natural-log units. */
const SIGMA_FLOOR = 0.1;
/** Spread multiplier (see the header: 1.2-1.6 scores best, 1.4 sits on the plateau). */
const SIGMA_SCALE = 1.4;
/** Pool launches below this count fall back to persistence instead of a thin fit. */
const MIN_POOL = 3;
/** Persistence spread, in natural-log units per square-root hour (the house baseline). */
const PERSIST_SIGMA = 0.15;

interface HourlyPoint {
  from: string;
  viewers: number;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Median of a non-empty list (sorted copy; the average of the two middles when even). */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Linear-interpolated quantile of a non-empty list. */
const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 1) return s[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return s[lo] * (1 - frac) + s[Math.min(lo + 1, n - 1)] * frac;
};

/** Robust spread of a list: its interquartile range in units of a normal sigma. */
const iqrSigma = (xs: number[]): number => (quantile(xs, 0.75) - quantile(xs, 0.25)) / 1.349;

/** Least-squares slope (and intercept) of ys on xs. */
const ols = (xs: number[], ys: number[]): [number, number] => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let den = 0;
  let num = 0;
  for (let i = 0; i < n; i++) {
    den += (xs[i] - mx) * (xs[i] - mx);
    num += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = den === 0 ? 0 : num / den;
  return [my - slope * mx, slope];
};

/** The tier a comparable's unlock note assigns it ("comparable", "weak", ...). */
const tierOf = (c: Comparable): string => {
  const m = /Tier:\s*([^.;]+)/.exec(c.unlock ?? '');
  return m ? m[1].trim() : '';
};

/** A launch's 24 UTC release-day viewer counts, or null when unusable as a curve. */
const releaseCurve = (c: Comparable): number[] | null => {
  const start = Date.parse(c.day_start);
  if (!Number.isFinite(start)) return null;
  const hours: Array<number | undefined> = new Array(25).fill(undefined);
  for (const pt of c.hourly ?? []) {
    const t = Date.parse(pt.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor((t - start) / 3600000) + 1;
    if (h >= 1 && h <= 24 && typeof pt.viewers === 'number' && Number.isFinite(pt.viewers)) {
      hours[h] = pt.viewers;
    }
  }
  const curve: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const v = hours[h];
    if (v === undefined || v < 1) return null;
    curve.push(v);
  }
  return curve;
};

/** The pool: console-only, tier-"comparable" launches with a complete release day. */
const buildPool = (c: Case): number[][] => {
  const curves: Array<{ name: string; curve: number[] }> = [];
  for (const comp of c.comparables ?? []) {
    if (tierOf(comp) !== 'comparable') continue;
    if ((comp.platforms ?? '').includes('PC')) continue;
    const curve = releaseCurve(comp);
    if (curve === null || curve[0] < MIN_POOL_H1) continue;
    curves.push({ name: comp.name, curve });
  }
  curves.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return curves.map((x) => x.curve);
};

interface Fit {
  /** Mean log(hour-1) of the pool, the regression's centre. */
  meanLogH1: number;
  /** Pooled slope of log-ratio on centred log(hour-1), hours REG_FROM-24. */
  beta: number;
  /** Per hour: [median log-ratio (regression-adjusted), sigma]. */
  hours: Map<number, [number, number]>;
}

/** Fit the shape and spreads from the pool's release-day curves. */
const fitModel = (pool: number[][]): Fit => {
  const logH1 = pool.map((curve) => Math.log(curve[0]));
  const meanLogH1 = logH1.reduce((a, b) => a + b, 0) / logH1.length;
  // One slope for hours REG_FROM-24: regress the per-hour-demeaned log-ratios
  // on the centred log(hour-1), pooling every hour's launches together.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let h = REG_FROM; h <= 24; h++) {
    const ratios = pool.map((curve) => Math.log(curve[h - 1] / curve[0]));
    const med = median(ratios);
    for (let i = 0; i < pool.length; i++) {
      xs.push(logH1[i] - meanLogH1);
      ys.push(ratios[i] - med);
    }
  }
  const [, beta] = ols(xs, ys);
  const hours = new Map<number, [number, number]>();
  for (let h = 2; h <= 24; h++) {
    if (h >= REG_FROM) {
      const resid = pool.map(
        (curve, i) => Math.log(curve[h - 1] / curve[0]) - beta * (logH1[i] - meanLogH1),
      );
      const alpha = median(resid);
      const sigma = Math.min(1, Math.max(iqrSigma(resid), SIGMA_FLOOR)) * SIGMA_SCALE;
      hours.set(h, [alpha, sigma]);
    } else {
      const ratios = pool.map((curve) => Math.log(curve[h - 1] / curve[0]));
      const sigma = Math.min(1, Math.max(iqrSigma(ratios), SIGMA_FLOOR)) * SIGMA_SCALE;
      hours.set(h, [median(ratios), sigma]);
    }
  }
  return { meanLogH1, beta, hours };
};

/** One hour's five quantiles from a fit and the case's hour-1 print. */
const hourQuantiles = (fit: Fit, p1: number, h: number): number[] => {
  const [alpha, sigma] = fit.hours.get(h) as [number, number];
  const med = alpha + (h >= REG_FROM ? fit.beta * (Math.log(p1) - fit.meanLogH1) : 0);
  const qs = Z.map((z) => p1 * Math.exp(med + z * sigma));
  const out: number[] = [];
  for (const q of qs) {
    const v = Number.isFinite(q) ? Math.min(Math.max(round2(q), 0.01), 1e9) : 1;
    out.push(out.length === 0 ? v : Math.max(v, out[out.length - 1]));
  }
  return out;
};

/** The house persistence forecast: flat at hour 1, spread widening with sqrt(h-1). */
const persistenceQuantiles = (p1: number, h: number): number[] => {
  const qs = Z.map((z) => round2(p1 * Math.exp(z * PERSIST_SIGMA * Math.sqrt(h - 1))));
  const out: number[] = [];
  for (const q of qs) {
    const v = Number.isFinite(q) ? Math.min(Math.max(q, 0.01), 1e9) : 1;
    out.push(out.length === 0 ? v : Math.max(v, out[out.length - 1]));
  }
  return out;
};

/** Forecast one case: the fitted model, or persistence when the pool is too thin. */
const forecastCase = (c: Case): Array<{ hour: number; q: number[] }> => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const pool = buildPool(c);
  const fit = pool.length >= MIN_POOL ? fitModel(pool) : null;
  return c.forecast.map(({ hour }) => ({
    hour,
    q: fit !== null ? hourQuantiles(fit, p1, hour) : persistenceQuantiles(p1, hour),
  }));
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
