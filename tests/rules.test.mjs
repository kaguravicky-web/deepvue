import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PRESETS,
  applyRsRating,
  breakoutAt,
  classify as classifyWith,
  computeMetrics as computeMetricsWith,
  isLeaderEligible,
  pickLeaders,
} from "../scripts/rules.js";

// These fixtures encode the first written spec, so they run against that
// preset. The Deepvue/Stockbee defaults get their own block at the bottom.
const SPEC = PRESETS["spec-v1"];
const PARAMS = SPEC;
const classify = (bars, index) => classifyWith(bars, index ?? bars.length - 1, SPEC);
const computeMetrics = (bars) => computeMetricsWith(bars, SPEC);

// ---------------------------------------------------------------------------
// Fixture helpers
//
// The base series is a slow uptrend on flat volume: it satisfies the Setup
// criteria and nothing else, so each test can turn on exactly one rule by
// overriding the last few bars.
// ---------------------------------------------------------------------------

const BASE_LENGTH = 120;
const BASE_VOLUME = 1_000_000;

function bar(index, close, overrides = {}) {
  return {
    date: `2026-01-${String(index).padStart(3, "0")}`,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: BASE_VOLUME,
    ...overrides,
  };
}

/** Slow uptrend, 80 → 97.85, flat volume. */
function baseBars(overrides = {}) {
  const bars = Array.from({ length: BASE_LENGTH }, (_, index) => bar(index, 80 + index * 0.15));
  for (const [index, patch] of Object.entries(overrides)) {
    const position = Number(index) < 0 ? bars.length + Number(index) : Number(index);
    bars[position] = { ...bars[position], ...patch };
  }
  return bars;
}

const last = (bars) => bars.length - 1;

/** Highest_20D as of yesterday — the pivot today has to clear. */
function priorPivot(bars) {
  return computeMetrics(bars)[last(bars) - 1].highest20;
}

// ---------------------------------------------------------------------------
// Base metrics
// ---------------------------------------------------------------------------

test("Close_Position measures where the close sits in the daily range", () => {
  const metrics = computeMetrics([
    { date: "d1", open: 10, high: 12, low: 8, close: 11, volume: 1 },
    { date: "d2", open: 10, high: 12, low: 8, close: 8, volume: 1 },
    { date: "d3", open: 10, high: 10, low: 10, close: 10, volume: 1 },
  ]);
  assert.equal(metrics[0].closePosition, 75);
  assert.equal(metrics[1].closePosition, 0);
  // Zero-range day: the close is the high.
  assert.equal(metrics[2].closePosition, 100);
});

test("RVOL divides volume by the 50-day average volume", () => {
  const bars = baseBars({ "-1": { volume: BASE_VOLUME * 2 } });
  const metrics = computeMetrics(bars);
  const tail = metrics.at(-1);
  const expectedAverage = (BASE_VOLUME * 49 + BASE_VOLUME * 2) / 50;
  assert.equal(tail.avgVol50, expectedAverage);
  assert.equal(tail.rvol, (BASE_VOLUME * 2) / expectedAverage);
});

test("15D_Range is the 15-day high/low spread over the latest close", () => {
  const bars = baseBars();
  const metrics = computeMetrics(bars);
  const tail = metrics.at(-1);
  assert.equal(tail.range15Pct, ((tail.highest15 - tail.lowest15) / tail.close) * 100);
  assert.ok(tail.range15Pct < 8, "base fixture should be tight");
});

test("EMA21 is seeded with the first close, matching pandas adjust=False", () => {
  const bars = baseBars();
  const metrics = computeMetrics(bars);
  assert.equal(metrics[0].ema21, bars[0].close);
  const k = 2 / 22;
  assert.ok(Math.abs(metrics[1].ema21 - (bars[1].close * k + bars[0].close * (1 - k))) < 1e-9);
});

test("3M_Performance compares against the close 63 bars back", () => {
  const bars = baseBars();
  const metrics = computeMetrics(bars);
  const tail = last(bars);
  const expected = (bars[tail].close / bars[tail - PARAMS.threeMonthBars].close - 1) * 100;
  assert.ok(Math.abs(metrics[tail].threeMonthPct - expected) < 1e-9);
});

// ---------------------------------------------------------------------------
// Rule 1 — Setup
// ---------------------------------------------------------------------------

test("Setup: uptrend holding just under the 20-day high in a tight range", () => {
  const result = classify(baseBars());
  assert.equal(result.mainState, "setup");
  assert.ok(result.close > result.sma20 && result.close > result.sma50);
  assert.ok(result.distanceToHighPct >= 0 && result.distanceToHighPct <= 5);
  assert.ok(result.range15Pct <= 12);
  assert.ok(result.threeMonthPct > 8);
});

test("Setup fails when 3-month performance is under 8%", () => {
  // Flat series: no momentum, everything else still benign.
  const bars = Array.from({ length: BASE_LENGTH }, (_, index) => bar(index, 100));
  const result = classify(bars);
  assert.equal(result.mainState, "watch");
  assert.equal(result.setupCriteriaMet, false);
});

test("Setup fails when the 15-day range is wider than 12%", () => {
  // One deep bar inside the 15-day window blows the range out.
  const bars = baseBars({ "-10": { low: 80, close: 85, high: 90 } });
  const result = classify(bars);
  assert.ok(result.range15Pct > 12);
  assert.equal(result.setupCriteriaMet, false);
});

test("Setup fails when price is more than 5% below the 20-day high", () => {
  const bars = baseBars({ "-1": { close: 88, high: 88.4, low: 87.6 } });
  const result = classify(bars);
  assert.ok(result.distanceToHighPct > 5);
  assert.equal(result.setupCriteriaMet, false);
});

// ---------------------------------------------------------------------------
// Rule 2 — Breakout
// ---------------------------------------------------------------------------

function breakoutTail(bars, closeValue) {
  return {
    open: closeValue - 1,
    high: closeValue + 0.2,
    low: closeValue - 1,
    close: closeValue,
    volume: BASE_VOLUME * 2,
  };
}

test("Breakout: closes above yesterday's 20-day high on 1.5x volume, strong close", () => {
  const pivot = priorPivot(baseBars());
  const bars = baseBars({ "-1": breakoutTail(baseBars(), pivot + 3) });
  const result = classify(bars);
  assert.equal(result.mainState, "breakout");
  assert.ok(result.rvol >= 1.5);
  assert.ok(result.closePosition >= 60);
});

test("Breakout fails on normal volume even with a new high", () => {
  const pivot = priorPivot(baseBars());
  const bars = baseBars({
    "-1": { ...breakoutTail(baseBars(), pivot + 3), volume: BASE_VOLUME },
  });
  const result = classify(bars);
  assert.notEqual(result.mainState, "breakout");
  assert.ok(result.rvol < 1.5);
});

test("Breakout fails when the close is in the lower part of the day", () => {
  const pivot = priorPivot(baseBars());
  const closeValue = pivot + 1;
  const bars = baseBars({
    "-1": {
      open: closeValue,
      high: closeValue + 5,
      low: closeValue - 0.2,
      close: closeValue,
      volume: BASE_VOLUME * 2,
    },
  });
  const metrics = computeMetrics(bars);
  const signal = breakoutAt(metrics, last(bars));
  assert.ok(signal.closePosition < 60);
  assert.equal(signal.valid, false);
});

// ---------------------------------------------------------------------------
// Rule 3 — Holding
// ---------------------------------------------------------------------------

/** Breakout `daysAgo` bars back, then flat bars holding at `holdClose`. */
function withPriorBreakout(daysAgo, holdClose) {
  const clean = baseBars();
  const metrics = computeMetrics(clean);
  const pivot = metrics[last(clean) - daysAgo - 1].highest20;
  const breakoutClose = pivot + 3;
  const overrides = { [-1 - daysAgo]: breakoutTail(clean, breakoutClose) };
  for (let offset = daysAgo - 1; offset >= 0; offset -= 1) {
    overrides[-1 - offset] = {
      open: holdClose,
      high: holdClose + 0.3,
      low: holdClose - 0.3,
      close: holdClose,
      volume: BASE_VOLUME,
    };
  }
  return { bars: baseBars(overrides), pivot };
}

test("Holding: breakout within the last 10 days, still above pivot and 21EMA", () => {
  const { bars, pivot } = withPriorBreakout(3, 101);
  const result = classify(bars);
  assert.equal(result.mainState, "holding");
  assert.ok(result.close >= pivot);
  assert.ok(result.close >= result.ema21 * 0.98);
  assert.equal(result.breakoutDaysAgo, 3);
});

test("Holding does not trigger on a breakout older than 10 days", () => {
  const { bars } = withPriorBreakout(12, 101);
  const result = classify(bars);
  assert.notEqual(result.mainState, "holding");
});

test("Holding fails when price slips more than 2% under the 21EMA", () => {
  // Same breakout, but the follow-through bars sag far below the average.
  const { bars } = withPriorBreakout(3, 101);
  const metrics = computeMetrics(bars);
  const ema21 = metrics.at(-1).ema21;
  const sunk = ema21 * 0.9;
  const patched = bars.map((item, index) =>
    index > last(bars) - 3
      ? { ...item, open: sunk, high: sunk + 0.2, low: sunk - 0.2, close: sunk }
      : item,
  );
  const result = classify(patched);
  assert.notEqual(result.mainState, "holding");
});

// ---------------------------------------------------------------------------
// Rule 4 — Fakeout
// ---------------------------------------------------------------------------

test("Fakeout A: pokes through the pivot, closes back under it, weak and heavy", () => {
  const clean = baseBars();
  const pivot = priorPivot(clean);
  const closeValue = pivot - 0.5;
  const bars = baseBars({
    "-1": {
      open: pivot + 1,
      high: pivot + 2,
      low: closeValue - 2,
      close: closeValue,
      volume: BASE_VOLUME * 2,
    },
  });
  const result = classify(bars);
  assert.equal(result.mainState, "fakeout");
  assert.equal(result.fakeoutReason, "intraday-rejection");
  assert.ok(result.closePosition < 50);
  assert.ok(result.rvol >= 1.5);
});

test("Fakeout A does not fire when the close holds the upper half of the day", () => {
  const clean = baseBars();
  const pivot = priorPivot(clean);
  const closeValue = pivot - 0.01;
  const bars = baseBars({
    "-1": {
      open: closeValue,
      high: pivot + 0.05,
      low: pivot - 0.5,
      close: closeValue,
      volume: BASE_VOLUME * 2,
    },
  });
  const result = classify(bars);
  assert.notEqual(result.fakeoutReason, "intraday-rejection");
});

test("Fakeout B: a breakout 1-5 days ago whose pivot has since been lost", () => {
  const { bars, pivot } = withPriorBreakout(3, 101);
  const belowPivot = pivot - 2;
  const patched = bars.map((item, index) =>
    index === last(bars)
      ? {
          ...item,
          open: belowPivot,
          high: belowPivot + 0.3,
          low: belowPivot - 0.3,
          close: belowPivot,
        }
      : item,
  );
  const result = classify(patched);
  assert.equal(result.mainState, "fakeout");
  assert.equal(result.fakeoutReason, "lost-pivot");
});

test("Fakeout B ignores a lost pivot from a breakout more than 5 days ago", () => {
  const { bars, pivot } = withPriorBreakout(8, 101);
  const belowPivot = pivot - 2;
  const patched = bars.map((item, index) =>
    index === last(bars)
      ? {
          ...item,
          open: belowPivot,
          high: belowPivot + 0.3,
          low: belowPivot - 0.3,
          close: belowPivot,
        }
      : item,
  );
  const result = classify(patched);
  assert.notEqual(result.fakeoutReason, "lost-pivot");
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test("Fakeout outranks Breakout on the same bar", () => {
  // Clears the pivot on volume, but a prior breakout's pivot is already lost.
  const { bars, pivot } = withPriorBreakout(2, 101);
  const belowPivot = pivot - 2;
  const patched = bars.map((item, index) =>
    index === last(bars)
      ? { ...item, open: belowPivot, high: pivot + 5, low: belowPivot - 3, close: belowPivot, volume: BASE_VOLUME * 3 }
      : item,
  );
  const result = classify(patched);
  assert.equal(result.mainState, "fakeout");
});

test("Breakout outranks Setup: a breakout bar can still meet the Setup criteria", () => {
  const pivot = priorPivot(baseBars());
  const bars = baseBars({ "-1": breakoutTail(baseBars(), pivot + 1) });
  const result = classify(bars);
  assert.equal(result.mainState, "breakout");
  // The old engine tied Tightness to the assigned state and lost this case.
  assert.equal(result.setupCriteriaMet, true);
});

test("every classified bar gets exactly one main state", () => {
  const result = classify(baseBars());
  assert.ok(["fakeout", "breakout", "holding", "setup", "watch"].includes(result.mainState));
});

// ---------------------------------------------------------------------------
// Rule 5 — Secondary tags
// ---------------------------------------------------------------------------

test("Tightness is a tag on the Setup criteria, not on the assigned state", () => {
  const pivot = priorPivot(baseBars());
  const breakout = classify(baseBars({ "-1": breakoutTail(baseBars(), pivot + 1) }));
  assert.equal(breakout.mainState, "breakout");
  assert.ok(breakout.range15Pct < 8);
  assert.equal(breakout.tightnessTag, true);
});

test("Tightness is off when the 15-day range is 8% or wider", () => {
  const bars = baseBars({ "-9": { low: 88, close: 92, high: 93 } });
  const result = classify(bars);
  assert.ok(result.range15Pct >= 8);
  assert.equal(result.tightnessTag, false);
});

/**
 * Undercuts the 5-day low by `undercutPct`, then reclaims it `gainPct` higher
 * on `rvol` volume, then drifts up for the rest of the window.
 */
function springBars({ undercutPct = -3, gainPct = 5, closePositionOk = true, rvol = 1.6 } = {}) {
  const clean = baseBars();
  const sweepIndex = BASE_LENGTH - 7;
  const support = Math.min(...clean.slice(sweepIndex - 5, sweepIndex).map((item) => item.low));

  const sweepClose = support * 0.98;
  const reclaimClose = sweepClose * (1 + gainPct / 100);
  const overrides = {
    [sweepIndex]: {
      open: sweepClose,
      high: sweepClose + 0.5,
      low: support * (1 + undercutPct / 100),
      close: sweepClose,
      volume: BASE_VOLUME,
    },
    [sweepIndex + 1]: {
      open: sweepClose,
      high: reclaimClose + 0.2,
      low: closePositionOk ? reclaimClose - 3 : reclaimClose - 0.2,
      close: closePositionOk ? reclaimClose : reclaimClose - 2.8,
      volume: BASE_VOLUME * rvol,
    },
  };
  for (let offset = 2; offset <= 6; offset += 1) {
    const drift = reclaimClose + offset * 0.4;
    overrides[sweepIndex + offset] = {
      open: drift,
      high: drift + 0.2,
      low: drift - 0.2,
      close: drift,
      volume: BASE_VOLUME,
    };
  }
  return baseBars(overrides);
}

test("Spring: undercut of the 5-day low reclaimed on a 4%+ volume day", () => {
  const result = classify(springBars());
  assert.equal(result.springTag, true);
  assert.ok(result.spring.undercutPct < 0 && result.spring.undercutPct >= -6);
  assert.ok(result.close > 0);
});

test("Spring needs a 4% gain on the reclaim day", () => {
  assert.equal(classify(springBars({ gainPct: 2 })).springTag, false);
});

test("Spring needs the reclaim day to close in the upper half-ish of its range", () => {
  assert.equal(classify(springBars({ closePositionOk: false })).springTag, false);
});

test("Spring needs RVOL of at least 1.15 on the reclaim day", () => {
  assert.equal(classify(springBars({ rvol: 1.0 })).springTag, false);
});

test("Spring rejects an undercut deeper than 6%", () => {
  assert.equal(classify(springBars({ undercutPct: -9 })).springTag, false);
});

test("Spring is a secondary tag and leaves the main state alone", () => {
  const withSpring = classify(springBars());
  assert.ok(["fakeout", "breakout", "holding", "setup", "watch"].includes(withSpring.mainState));
  assert.equal(withSpring.springTag, true);
});

// ---------------------------------------------------------------------------
// Rule 6 — Leaders
// ---------------------------------------------------------------------------

const stock = (ticker, mainState, marketCap, etfWeight, springTag = false) => ({
  ticker,
  mainState,
  marketCap,
  etfWeight,
  springTag,
});

test("Leaders exclude Fakeout, even when it carries a Spring tag", () => {
  assert.equal(isLeaderEligible(stock("A", "fakeout", 1e12, 5, true)), false);
  assert.equal(isLeaderEligible(stock("B", "watch", 1e12, 5)), false);
  assert.equal(isLeaderEligible(stock("C", "watch", 1e12, 5, true)), true);
  assert.equal(isLeaderEligible(stock("D", "setup", 1e12, 5)), true);
  assert.equal(isLeaderEligible(stock("E", "breakout", 1e12, 5)), true);
  assert.equal(isLeaderEligible(stock("F", "holding", 1e12, 5)), true);
});

test("Leaders rank by market cap weighted up for ETF membership", () => {
  // MID 5e11 x (1 + 8/5) = 1.30e12 edges out BIG 1e12 x (1 + 0.5/5) = 1.10e12.
  const leaders = pickLeaders([
    stock("SMALL", "setup", 1e10, 10),
    stock("BIG", "breakout", 1e12, 0.5),
    stock("MID", "holding", 5e11, 8),
  ]);
  assert.deepEqual(leaders.map((item) => item.ticker), ["MID", "BIG", "SMALL"]);
});

test("ETF weight can outrank a larger market cap", () => {
  // 1.0e12 * (1 + 0/5) = 1.00e12 versus 0.9e12 * (1 + 10/5) = 2.7e12.
  const leaders = pickLeaders([stock("PLAIN", "setup", 1e12, 0), stock("HEAVY", "setup", 9e11, 10)]);
  assert.equal(leaders[0].ticker, "HEAVY");
});

test("Leaders are capped at three names", () => {
  const pool = Array.from({ length: 8 }, (_, index) =>
    stock(`T${index}`, "setup", (8 - index) * 1e11, 1),
  );
  assert.equal(pickLeaders(pool).length, 3);
});

// ---------------------------------------------------------------------------
// Deepvue / Stockbee defaults
//
// The preset above is the earlier spec. Everything below runs against the
// working default and pins the parts that differ from it.
// ---------------------------------------------------------------------------

const DV = PRESETS["deepvue-stockbee"];
const classifyDv = (bars, index) => classifyWith(bars, index ?? bars.length - 1, DV);
const metricsDv = (bars) => computeMetricsWith(bars, DV);

/** Base uptrend whose last `days` bars trade on `ratio` of normal volume. */
function dryingBase(days = 12, ratio = 0.5) {
  const overrides = {};
  for (let offset = 0; offset < days; offset += 1) {
    overrides[-1 - offset] = { volume: BASE_VOLUME * ratio };
  }
  return baseBars(overrides);
}

test("RMV is normalised 0-100, not an absolute percentage", () => {
  const metrics = metricsDv(baseBars());
  const values = metrics.slice(-30).map((item) => item.rmv).filter((item) => item != null);
  assert.ok(values.length > 0, "RMV should be defined once history is long enough");
  assert.ok(values.every((value) => value >= 0 && value <= 100));
});

test("RMV spikes when one bar's range blows out", () => {
  const quiet = metricsDv(baseBars()).at(-1).rmv;
  assert.equal(quiet, 0, "a base with no range variation reads fully tight");
  const shocked = metricsDv(baseBars({ "-1": { high: 130, low: 70 } })).at(-1).rmv;
  assert.ok(shocked > quiet, `expected ${shocked} > ${quiet}`);
  assert.equal(shocked, 100);
});

test("RMV rates a wide and a narrow stock on the same scale", () => {
  // Same shape, 10x the price and 10x the range. An absolute range threshold
  // separates these two; a normalised one must not. The jitter gives the
  // window a real spread to normalise against.
  const narrow = baseBars().map((item, index) => {
    const width = 1 + (index % 7) * 0.004;
    return { ...item, high: item.close * width, low: item.close * (2 - width) };
  });
  const wide = narrow.map((item) => ({
    ...item,
    open: item.open * 10,
    high: item.high * 10,
    low: item.low * 10,
    close: item.close * 10,
  }));
  const a = metricsDv(narrow).at(-1).rmv;
  const b = metricsDv(wide).at(-1).rmv;
  assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
});

test("volume dry-up compares the 10-day average against the 50-day", () => {
  const flat = metricsDv(baseBars()).at(-1).volumeDryUp;
  assert.ok(Math.abs(flat - 1) < 1e-9, "flat volume should read 1.0");
  const drying = metricsDv(dryingBase(12, 0.5)).at(-1).volumeDryUp;
  assert.ok(drying < 0.8, `expected dry-up below 0.8, got ${drying}`);
});

test("Setup now requires the base to dry up", () => {
  // Identical price action; only the volume behaviour differs.
  assert.equal(classifyDv(baseBars()).setupCriteriaMet, false);
  assert.equal(classifyDv(dryingBase()).setupCriteriaMet, true);
});

test("Setup requires close > SMA20 > SMA50, not just above both", () => {
  const metrics = metricsDv(dryingBase());
  const tail = metrics.at(-1);
  assert.ok(tail.close > tail.sma20 && tail.sma20 > tail.sma50);
});

test("Breakout needs a 70% close position, not 60%", () => {
  const clean = dryingBase();
  const pivot = metricsDv(clean)[last(clean) - 1].highest20;
  const value = pivot + 2;
  // Close two thirds of the way up the day: passes the old bar, fails this one.
  const bars = dryingBase();
  bars[last(bars)] = {
    ...bars[last(bars)],
    open: value - 3,
    high: value + 1,
    low: value - 2,
    close: value,
    volume: BASE_VOLUME * 3,
  };
  const signal = breakoutAt(metricsDv(bars), last(bars), DV);
  assert.ok(signal.closePosition >= 60 && signal.closePosition < 70, `${signal.closePosition}`);
  assert.equal(signal.valid, false);
  assert.equal(breakoutAt(computeMetricsWith(bars, SPEC), last(bars), SPEC).valid, true);
});

test("Breakout also needs volume above the prior day (Stockbee)", () => {
  const bars = dryingBase();
  const pivot = metricsDv(bars)[last(bars) - 1].highest20;
  const value = pivot + 2;
  // 2x the 50-day average, but the day before was heavier still.
  bars[last(bars) - 1] = { ...bars[last(bars) - 1], volume: BASE_VOLUME * 4 };
  bars[last(bars)] = {
    ...bars[last(bars)],
    open: value - 0.5,
    high: value + 0.1,
    low: value - 0.6,
    close: value,
    volume: BASE_VOLUME * 2,
  };
  const metrics = metricsDv(bars);
  const signal = breakoutAt(metrics, last(bars), DV);
  assert.ok(metrics.at(-1).rvol >= 1.5);
  assert.ok(metrics.at(-1).closePosition >= 70);
  assert.equal(metrics.at(-1).volumeAbovePriorDay, false);
  assert.equal(signal.valid, false);
});

test("Holding looks back 5 days, not 10", () => {
  assert.equal(DV.holdingLookbackDays, 5);
  assert.equal(SPEC.holdingLookbackDays, 10);
});

test("RS gate demotes Setup to Watch and clears the Tight tag", () => {
  const verdict = classifyDv(dryingBase());
  assert.equal(verdict.mainState, "setup");
  const gated = applyRsRating(verdict, 40, DV);
  assert.equal(gated.mainState, "watch");
  assert.equal(gated.setupCriteriaMet, false);
  assert.equal(gated.tightnessTag, false);
  const kept = applyRsRating(verdict, 92, DV);
  assert.equal(kept.mainState, "setup");
});

test("RS gate never touches Breakout, Holding or Fakeout", () => {
  for (const state of ["breakout", "holding", "fakeout"]) {
    const gated = applyRsRating({ mainState: state, setupCriteriaMet: true, tightnessTag: true }, 1, DV);
    assert.equal(gated.mainState, state);
  }
});

test("RS gate is inert when the preset does not set one", () => {
  const verdict = { mainState: "setup", setupCriteriaMet: true, tightnessTag: true };
  assert.deepEqual(applyRsRating(verdict, 1, SPEC), verdict);
});
