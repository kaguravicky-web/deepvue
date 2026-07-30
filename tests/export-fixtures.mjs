/**
 * Writes the JS rule fixtures to CSV plus their expected verdicts, so
 * tests/test_rules_parity.py can prove the pandas reference agrees with
 * scripts/rules.mjs bar for bar.
 *
 *   node tests/export-fixtures.mjs > tests/fixtures.json
 */
import { classify } from "../scripts/rules.js";

const BASE_LENGTH = 120;
const BASE_VOLUME = 1_000_000;

const bar = (index, close, overrides = {}) => ({
  date: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
  open: close,
  high: close * 1.005,
  low: close * 0.995,
  close,
  volume: BASE_VOLUME,
  ...overrides,
});

function baseBars(overrides = {}) {
  const bars = Array.from({ length: BASE_LENGTH }, (_, index) => bar(index, 80 + index * 0.15));
  for (const [key, patch] of Object.entries(overrides)) {
    const position = Number(key) < 0 ? bars.length + Number(key) : Number(key);
    bars[position] = { ...bars[position], ...patch };
  }
  return bars;
}

const priorPivot = (bars) => classify(bars).highest20;

const breakoutTail = (value) => ({
  open: value - 1,
  high: value + 0.2,
  low: value - 1,
  close: value,
  volume: BASE_VOLUME * 2,
});

function withPriorBreakout(daysAgo, holdClose) {
  const clean = baseBars();
  const pivot = classify(clean, clean.length - 1 - daysAgo).highest20;
  const overrides = { [-1 - daysAgo]: breakoutTail(pivot + 3) };
  for (let offset = daysAgo - 1; offset >= 0; offset -= 1) {
    overrides[-1 - offset] = {
      open: holdClose,
      high: holdClose + 0.3,
      low: holdClose - 0.3,
      close: holdClose,
      volume: BASE_VOLUME,
    };
  }
  return baseBars(overrides);
}

function springBars({ undercutPct = -3, gainPct = 5, rvol = 1.6 } = {}) {
  const clean = baseBars();
  const sweep = BASE_LENGTH - 7;
  const support = Math.min(...clean.slice(sweep - 5, sweep).map((item) => item.low));
  const sweepClose = support * 0.98;
  const reclaimClose = sweepClose * (1 + gainPct / 100);
  const overrides = {
    [sweep]: {
      open: sweepClose,
      high: sweepClose + 0.5,
      low: support * (1 + undercutPct / 100),
      close: sweepClose,
      volume: BASE_VOLUME,
    },
    [sweep + 1]: {
      open: sweepClose,
      high: reclaimClose + 0.2,
      low: reclaimClose - 3,
      close: reclaimClose,
      volume: BASE_VOLUME * rvol,
    },
  };
  for (let offset = 2; offset <= 6; offset += 1) {
    const drift = reclaimClose + offset * 0.4;
    overrides[sweep + offset] = {
      open: drift,
      high: drift + 0.2,
      low: drift - 0.2,
      close: drift,
      volume: BASE_VOLUME,
    };
  }
  return baseBars(overrides);
}

const flatPivot = priorPivot(baseBars());

const cases = {
  SETUP: baseBars(),
  WATCH: Array.from({ length: BASE_LENGTH }, (_, index) => bar(index, 100)),
  BREAKOUT: baseBars({ "-1": breakoutTail(flatPivot + 3) }),
  BREAKOUT_NOVOL: baseBars({ "-1": { ...breakoutTail(flatPivot + 3), volume: BASE_VOLUME } }),
  HOLDING: withPriorBreakout(3, 101),
  HOLDING_STALE: withPriorBreakout(12, 101),
  FAKEOUT_A: baseBars({
    "-1": {
      open: flatPivot + 1,
      high: flatPivot + 2,
      low: flatPivot - 2.5,
      close: flatPivot - 0.5,
      volume: BASE_VOLUME * 2,
    },
  }),
  SPRING: springBars(),
  SPRING_WEAK_GAIN: springBars({ gainPct: 2 }),
  SPRING_DEEP: springBars({ undercutPct: -9 }),
};

const rows = [];
const expected = {};

for (const [ticker, bars] of Object.entries(cases)) {
  for (const item of bars) {
    rows.push({ ticker, ...item, market_cap: 1e11, etf_weight: 2.5 });
  }
  const verdict = classify(bars);
  expected[ticker] = {
    main_state: verdict.mainState,
    spring_tag: verdict.springTag,
    tightness_tag: verdict.tightnessTag,
    setup_criteria_met: verdict.setupCriteriaMet,
    fakeout_reason: verdict.fakeoutReason,
    close_position: verdict.closePosition,
    rvol: verdict.rvol,
    range15_pct: verdict.range15Pct,
    three_month_pct: verdict.threeMonthPct,
    distance_to_high_pct: verdict.distanceToHighPct,
    ema21: verdict.ema21,
    sma20: verdict.sma20,
    sma50: verdict.sma50,
  };
}

process.stdout.write(JSON.stringify({ rows, expected }, null, 2));
