// gta6-trophy-rarity-forecast-01 — forecaster (Node 22, standard library only).
//
// Model, per case, per trophy j (rate r_j = earners E_j / players tracked P):
//   * Earners and players are both monotone, so each is fitted as a power law in
//     log time, ln(E_j + 0.5) ~ a_j + b_j * ln(1 + t) and ln P ~ c + d * ln(1 + t),
//     t = hours since the release day began. The forecast rate is E_j(T) / P(T)
//     at the target T. A trophy whose earners grow faster than the player base
//     rises; one whose earners lag the player base falls (dilution). Slopes are
//     shrunk toward their tier median, so noisy low-count trophies borrow strength.
//     The same fit is also done on the last 24 hours of reads only, and a
//     quadratic is fitted to ln(earners) and to logit(rate) against log time
//     over the whole history (their curvatures, halved, catch a saturating
//     trophy bending down; the two are averaged in logit space, since earners
//     carry no refresh sawtooth while rates see the saturation directly).
//     The forecast takes the LOWEST of the three predictions (in logit
//     space): a saturating trophy's early growth makes the whole-history power
//     law explode toward 100% (its failure mode is unbounded overshoot), while
//     the recent window and the quadratics see the current, decelerated growth.
//     The gap between the predictions is added to the spread, so disagreement
//     widens the band.
//   * Stale-page branch: if players-tracked never moved in the whole history,
//     Exophase has not refreshed the page once in the observed window, so a
//     refresh before the target is expected and it dilutes rates: new players
//     arrive having earned almost nothing yet (the first refresh on launch night
//     took players 638 -> 3868 while total trophies earned went 943 -> 4276, so
//     the 3230 new players held ~1 trophy each, the intro mission, and ~0.03
//     other trophies each). The median is multiplied by ~0.22 and the spread
//     widened.
//   * Spreads combine the random-walk term, the fit's residual, refresh
//     uncertainty, binomial count noise and an extrapolation penalty, so the
//     90% band is honest about how far the target sits beyond the data.
//   * The intro-mission trophy (last rate >= 99.9%) is forecast at ~100% with a
//     one-sided lower tail: it stayed exactly 100% through the first refresh.
//   * Story-ladder medians are kept ordered (Chapter 1 >= ... >= final mission
//     >= 100% completion >= platinum) when those trophies are identified.
// Deterministic, no network, O(reads * trophies) work.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, logit units per square-root day. Below the baseline's
 *  0.5: this forecaster's median follows the trend rather than persisting the
 *  last rate, so less of the move is left to the random-walk term; the
 *  disagreement and fit terms carry the model error instead. */
const SIGMA_RW = 0.4;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number | null;
  trophies_earned: number | null;
  rates: Array<number | null>;
}

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const clampPct = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-clamp(l, -12, 12)));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Least-squares line y ~ a + b*x; returns {a, b, mx, my, residSd, n}, where the
 *  line is y = my + b*(x - mx): forecasts with a shrunk slope must pivot on the
 *  data centroid (mx, my), not on the x=0 intercept, or shrinkage bends the
 *  extrapolation by (b_shrunk - b) * xTarget. */
function linfit(xs: number[], ys: number[]): { a: number; b: number; mx: number; my: number; residSd: number; n: number } {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0, mx: 0, my: 0, residSd: 0, n: 0 };
  if (n === 1) return { a: ys[0], b: 0, mx: xs[0], my: ys[0], residSd: 0, n: 1 };
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  const residSd = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { a, b, mx, my, residSd, n };
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const nT = c.trophies.length;
  const horizonDays = c.horizon_minutes / 1440;
  const releaseMs = Date.parse(c.game?.release_date ?? '2026-11-19') || Date.parse('2026-11-19T00:00:00Z');
  const targetMs = Date.parse(c.target);
  const lastMs = c.history.length > 0 ? Date.parse(c.history[c.history.length - 1].at) : targetMs;
  // Hours since the release day began, for each read and for the target.
  const xOf = (ms: number): number => Math.log(1 + Math.max(0, (ms - releaseMs) / 3600000));
  const xTarget = xOf(targetMs);
  const xLast = c.history.length > 0 ? xOf(lastMs) : xTarget;
  const extrap = Math.max(0, xTarget - xLast); // log-time beyond the data

  // Last rate per trophy (fallback 0.5% when a read lacks it).
  const lastRead = c.history[c.history.length - 1];
  const lastRate: number[] = c.trophies.map((_, i) => {
    const r = lastRead?.rates?.[i];
    return typeof r === 'number' && Number.isFinite(r) ? r : 0.5;
  });

  // Players-tracked range (for the stale-page check) and last value.
  let pMin = Infinity, pMax = -Infinity, pCount = 0;
  for (const h of c.history) {
    const p = h.players_tracked;
    if (typeof p === 'number' && p > 0) {
      pCount++;
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
    }
  }
  const pLast = pMax > 0 && pMax < Infinity ? pMax : 638;

  // Stale page: players tracked never moved in the whole history, so no refresh
  // has been observed at all. A refresh before the target is then expected and
  // it dilutes every non-trivial rate (see header). Trigger only when the
  // history actually spans time (else there is nothing stale about it).
  const historySpanH = c.history.length > 1
    ? (Date.parse(c.history[c.history.length - 1].at) - Date.parse(c.history[0].at)) / 3600000
    : 0;
  const stale = pCount >= 2 && pMin === pMax && historySpanH >= 1;
  // Total median factor from the last rate to the refreshed rate in a stale
  // case: the first launch-night refresh took non-trivial rates to ~0.22x
  // (earn 943 -> 4276 on players 638 -> 3868, new players holding ~0.03 other
  // trophies each). The spread below covers the unknown refresh size.
  const STALE_FACTOR = 0.22;
  const REFRESH_SD = 0.3;

  // Fit ln(earners) and ln(players) as power laws in log time over a window of
  // reads. Returns the fits plus the players forecast at the target.
  type Fit = { a: number; b: number; mx: number; my: number; residSd: number; n: number };
  const fitWindow = (reads: Read[]): { pFit: Fit; pTarget: number; fits: Fit[]; tierMed: Map<string, number>; globalMed: number } => {
    const px: number[] = [];
    const py: number[] = [];
    for (const h of reads) {
      const p = h.players_tracked;
      if (typeof p === 'number' && p > 0) { px.push(xOf(Date.parse(h.at))); py.push(Math.log(p)); }
    }
    const pFit = linfit(px, py);
    const pTarget = Math.max(pLast, Math.exp(pFit.n > 0 ? pFit.my + pFit.b * (xTarget - pFit.mx) : Math.log(pLast)));
    const slopesByTier = new Map<string, number[]>();
    const fits: Fit[] = [];
    for (let j = 0; j < nT; j++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const h of reads) {
        const r = h.rates?.[j];
        const p = h.players_tracked;
        if (typeof r === 'number' && typeof p === 'number' && p > 0) {
          xs.push(xOf(Date.parse(h.at)));
          ys.push(Math.log(r * p / 100 + 0.5));
        }
      }
      const f = linfit(xs, ys);
      fits.push(f);
      const arr = slopesByTier.get(c.trophies[j].tier) ?? [];
      arr.push(f.b);
      slopesByTier.set(c.trophies[j].tier, arr);
    }
    const tierMed = new Map<string, number>();
    for (const [tier, bs] of slopesByTier) tierMed.set(tier, median(bs));
    return { pFit, pTarget, fits, tierMed, globalMed: median(fits.map((f) => f.b)) };
  };
  // Whole history, and the last 24 hours only (the recent window sees the
  // current, possibly decelerated, growth; with fewer than 5 recent reads it
  // is the whole history).
  const recentReads = c.history.filter((h) => Date.parse(h.at) >= lastMs - 24 * 3600000);
  const g = fitWindow(c.history);
  const r = recentReads.length >= 5 ? fitWindow(recentReads) : g;
  const pFit = g.pFit;
  const pTarget = g.pTarget;

  const out: Array<{ id: number; q: number[] }> = [];
  for (let j = 0; j < nT; j++) {
    const t = c.trophies[j];
    const rLast = lastRate[j];

    // The intro-mission trophy: ~every tracked player holds it, and it stayed
    // exactly 100% through the first refresh. Forecast ~100% with a lower tail.
    if (rLast >= 99.9) {
      out.push({ id: t.id, q: [99.0, 99.9, 99.99, 99.99, 99.99] });
      continue;
    }

    // Forecast earners at the target from a window's fit (slope shrunk toward
    // its tier median, pivoting on the centroid; the +0.5 count offset is
    // undone after exponentiating so small counts are not inflated).
    const earnersAt = (w: { fits: Fit[]; tierMed: Map<string, number>; globalMed: number; pTarget: number }): { e: number; residSd: number } => {
      const f = w.fits[j];
      const tierMed = w.tierMed.get(t.tier) ?? w.globalMed;
      // With hundreds of reads a trophy's own slope is precise, so the weight
      // is high there; with few reads the tier median carries it.
      const wt = f.n >= 50 ? 0.9 : f.n >= 10 ? 0.75 : f.n >= 3 ? 0.5 : 0.25;
      const b = wt * f.b + (1 - wt) * tierMed;
      const logE = f.n > 0 ? f.my + b * (xTarget - f.mx) : Math.log(Math.max(0.5, rLast * pLast / 100));
      return { e: Math.max(0.05, Math.exp(logE) - 0.5), residSd: f.residSd };
    };
    const eg = earnersAt(g);
    const er = earnersAt(r);
    const medG = clampPct(100 * (eg.e / g.pTarget));
    const medR = clampPct(100 * (er.e / r.pTarget));
    // Two quadratics in log time, averaged in logit space: one on ln(earners)
    // (no refresh sawtooth, so its curvature is real deceleration) and one on
    // logit(rate) (it sees the rate's saturation directly, but the recorder's
    // refresh steps bend it down a little even on a pure power law). Averaging
    // them keeps the saturation correction without the artefact's full bite.
    // Each is centred on its data centroid so halving the curvature keeps the
    // fit anchored. Only deceleration is trusted at half strength; acceleration
    // is kept as fitted, but the min() below never lets it lift the forecast
    // above the other two predictions.
    const quad = (ys: (rr: number, p: number) => number, toRate: (pred: number) => number): number => {
      const qx: number[] = [];
      const qy: number[] = [];
      for (const h of c.history) {
        const rr = h.rates?.[j];
        const p = h.players_tracked;
        if (typeof rr === 'number' && typeof p === 'number' && p > 0) {
          qx.push(xOf(Date.parse(h.at)));
          qy.push(ys(rr, p));
        }
      }
      if (qx.length < 20) return NaN;
      const n = qx.length;
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) { mx += qx[i]; my += qy[i]; }
      mx /= n; my /= n;
      let vx = 0;
      const u: number[] = new Array(n);
      const v: number[] = new Array(n);
      for (let i = 0; i < n; i++) { u[i] = qx[i] - mx; vx += u[i] * u[i]; }
      vx /= n;
      for (let i = 0; i < n; i++) v[i] = u[i] * u[i] - vx;
      let suu = 0, suv = 0, svv = 0, suy = 0, svy = 0;
      for (let i = 0; i < n; i++) {
        suu += u[i] * u[i]; suv += u[i] * v[i]; svv += v[i] * v[i];
        suy += u[i] * (qy[i] - my); svy += v[i] * (qy[i] - my);
      }
      const det = suu * svv - suv * suv;
      if (Math.abs(det) <= 1e-12) return NaN;
      const bq = (suy * svv - svy * suv) / det;
      const cq = (svy * suu - suy * suv) / det;
      const ch = cq < 0 ? 0.5 * cq : cq;
      const dx = xTarget - mx;
      return toRate(my + bq * dx + ch * (dx * dx - vx));
    };
    const qE = quad((rr, p) => Math.log(rr * p / 100 + 0.5), (pred) => clampPct(100 * (Math.max(0.05, Math.exp(pred) - 0.5) / g.pTarget)));
    const qR = quad((rr) => logit(rr), (pred) => clampPct(invLogit(pred)));
    let medQ = medR;
    if (Number.isFinite(qE) && Number.isFinite(qR)) medQ = clampPct(invLogit((logit(qE) + logit(qR)) / 2));
    else if (Number.isFinite(qE)) medQ = qE;
    else if (Number.isFinite(qR)) medQ = qR;
    // Lowest of the three predictions in logit space.
    let med = Math.min(logit(medG), logit(medR), logit(medQ));
    const disagree = Math.max(logit(medG), logit(medR), logit(medQ)) - med;
    // Stale page: the trend machinery cannot see the coming refresh (players
    // never moved), so the median is the last rate times the refresh factor.
    if (stale) med = logit(rLast * STALE_FACTOR);
    med = clampPct(invLogit(med));
    const eTarget = medR <= medG ? er.e : eg.e;

    // Spread: random walk + fit residual + refresh uncertainty + count noise
    // + extrapolation penalty + window disagreement. Floored so the band is
    // never dishonestly tight.
    const rw = SIGMA_RW * Math.sqrt(Math.max(horizonDays, 0));
    const resid = Math.max(eg.residSd, er.residSd, 0.05);
    const fitVar = stale ? 0 : resid * resid * (1 + extrap);
    const refreshVar = stale ? REFRESH_SD * REFRESH_SD : (pFit.n >= 3 && pMax > pMin ? 0.25 * 0.25 : 0.25 * 0.25);
    const countVar = 1 / (Math.max(eTarget, 0.5) + 1);
    const extrapVar = stale ? 0 : 0.05 * extrap;
    const disagreeVar = stale ? 0 : 0.25 * disagree * disagree;
    let s = Math.sqrt(rw * rw + fitVar + refreshVar + countVar + extrapVar + disagreeVar);
    s = clamp(s, 0.3, 3.0);

    const lm = logit(med);
    const q = Z.map((z) => round4(clamp(invLogit(lm + z * s), 0.01, 99.99)));
    // Rounding keeps the order, but enforce non-decreasing defensively.
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    out.push({ id: t.id, q });
  }

  // Story-ladder monotonicity on the medians: a later chapter cannot be earned
  // by more players than an earlier one, nor the platinum by more than the
  // 100%-completion gold. Detected from descriptions; skipped if not found.
  const findIdx = (re: RegExp): number => c.trophies.findIndex((t) => re.test(t.description));
  const chain: number[] = [];
  for (let ch = 1; ch <= 9; ch++) {
    const i = findIdx(new RegExp(`Chapter ${ch}\\b`));
    if (i >= 0) chain.push(i);
  }
  const fin = findIdx(/final mission/i);
  if (fin >= 0) chain.push(fin);
  const full = findIdx(/100% Completion/);
  if (full >= 0) chain.push(full);
  const plat = c.trophies.findIndex((t) => t.tier === 'platinum');
  if (plat >= 0) chain.push(plat);
  if (chain.length >= 2) {
    // Backward pass: each earlier trophy's median >= the later one's.
    for (let k = chain.length - 2; k >= 0; k--) {
      const a = out[chain[k]], b = out[chain[k + 1]];
      if (a.q[2] < b.q[2]) {
        const lm = logit(b.q[2]);
        // Rebuild a's row around b's median, keeping a's own spread.
        const sA = (logit(a.q[4]) - logit(a.q[0])) / (Z[4] - Z[0]);
        a.q = Z.map((z) => round4(clamp(invLogit(lm + z * Math.max(sA, 0.3)), 0.01, 99.99)));
        for (let m = 1; m < a.q.length; m++) if (a.q[m] < a.q[m - 1]) a.q[m] = a.q[m - 1];
      }
    }
  }
  return out;
}

/** Fallback forecast (never crash, never an invalid case): last rates, wide band. */
function fallbackCase(c: Case): Array<{ id: number; q: number[] }> {
  const lastRead = c.history[c.history.length - 1];
  const spread = 0.5 * Math.sqrt(Math.max(c.horizon_minutes / 1440, 0)) + 0.8;
  return c.trophies.map((t, i) => {
    const r = lastRead?.rates?.[i];
    const med = typeof r === 'number' && Number.isFinite(r) ? clampPct(r) : 0.5;
    if (med >= 99.9) return { id: t.id, q: [99.0, 99.9, 99.99, 99.99, 99.99] };
    const lm = logit(med);
    const q = Z.map((z) => round4(clamp(invLogit(lm + z * spread), 0.01, 99.99)));
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (!Array.isArray(c.trophies) || c.trophies.length === 0) throw new Error(`${file} has no trophies`);
  if (!Array.isArray(c.history) || c.history.length === 0) throw new Error(`${file} has no history`);
  let trophies: Array<{ id: number; q: number[] }>;
  try {
    trophies = forecastCase(c);
  } catch {
    trophies = fallbackCase(c);
  }
  // Final shape guard: one row per trophy, five finite non-decreasing 0..100.
  if (trophies.length !== c.trophies.length) trophies = fallbackCase(c);
  for (const row of trophies) {
    if (!Array.isArray(row.q) || row.q.length !== 5 || row.q.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) {
      trophies = fallbackCase(c);
      break;
    }
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
