/**
 * Compare RMV normalisation windows against real bars.
 *
 * A normalisation window close to the longest ATR period makes the reading
 * near-binary: the smoothed series barely moves inside the window, so the
 * latest bar is almost always its own min or max. This prints the resulting
 * distribution so the window can be chosen on evidence.
 *
 *   node scripts/tune-rmv.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PARAMS, computeMetrics } from "./rules.js";

const bars = JSON.parse(readFileSync(join("work", "bars-sample.json"), "utf8"));

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p5: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95) };
}

const variants = [
  { label: "atr 5/10/15, window 15 (current)", atr: [5, 10, 15], window: 15 },
  { label: "atr 5/10/15, window 30", atr: [5, 10, 15], window: 30 },
  { label: "atr 5/10/15, window 60", atr: [5, 10, 15], window: 60 },
  { label: "atr 5/10/15, window 120", atr: [5, 10, 15], window: 120 },
  { label: "atr 3/5/8,   window 60", atr: [3, 5, 8], window: 60 },
  { label: "atr 5 only,  window 60", atr: [5], window: 60 },
];

console.log(`sample: ${Object.keys(bars).length} tickers\n`);
console.log(
  "variant".padEnd(36),
  "p5".padStart(6),
  "p25".padStart(6),
  "p50".padStart(6),
  "p75".padStart(6),
  "p95".padStart(6),
  "=0%".padStart(7),
  "=100%".padStart(7),
  "<=15%".padStart(7),
);

for (const variant of variants) {
  const params = { ...PARAMS, rmvAtrPeriods: variant.atr, rmvLookback: variant.window };
  const values = [];
  for (const series of Object.values(bars)) {
    if (series.length < 200) continue;
    const value = computeMetrics(series, params).at(-1).rmv;
    if (value != null) values.push(value);
  }
  const q = quantiles(values);
  const share = (predicate) =>
    `${((values.filter(predicate).length / values.length) * 100).toFixed(1)}%`.padStart(7);
  console.log(
    variant.label.padEnd(36),
    q.p5.toFixed(1).padStart(6),
    q.p25.toFixed(1).padStart(6),
    q.p50.toFixed(1).padStart(6),
    q.p75.toFixed(1).padStart(6),
    q.p95.toFixed(1).padStart(6),
    share((value) => value === 0),
    share((value) => value === 100),
    share((value) => value <= 15),
  );
}
