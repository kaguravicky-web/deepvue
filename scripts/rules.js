/**
 * Single source of truth for the scanner's state definitions.
 *
 * Nothing else in this repo is allowed to decide what "Setup" or "Fakeout"
 * means. The sync script computes states here and writes them into the feed;
 * the page only renders what it is given. Every rule below maps 1:1 onto the
 * written spec, and tests/rules.test.mjs pins each one with a fixture.
 *
 * Bars are daily OHLCV, oldest first:
 *   { date, open, high, low, close, volume }
 */

// ---------------------------------------------------------------------------
// Tunables. These are the only numbers in the file that are a judgement call
// rather than a direct transcription of the spec.
// ---------------------------------------------------------------------------

export const PARAMS = {
  setupMaxDistanceToHighPct: 5,
  setupMaxRange15Pct: 12,
  setupMinThreeMonthPct: 8,
  breakoutMinRvol: 1.5,
  breakoutMinClosePosition: 60,
  holdingLookbackDays: 10,
  holdingEma21Buffer: 0.98,
  fakeoutMaxClosePosition: 50,
  fakeoutMinRvol: 1.5,
  fakeoutLookbackDays: 5,
  tightnessMaxRange15Pct: 8,
  springLookbackDays: 12,
  springUndercutMinPct: -6,
  springReclaimWindow: 5,
  springMinGainPct: 4,
  springMinClosePosition: 45,
  springMinRvol: 1.15,
  // "the support must not have been clearly lost again" — a close this far
  // below the swept support after the reclaim day invalidates the spring.
  springSupportLossBuffer: 0.98,
  leaderLimit: 3,
  leaderWeightDivisor: 5,
  threeMonthBars: 63,
};

// ---------------------------------------------------------------------------
// Base metrics
// ---------------------------------------------------------------------------

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Rolling SMA. Index i is the mean of the `period` values ending at i. */
function rollingMean(values, period) {
  return values.map((_, index) =>
    index + 1 < period ? null : mean(values.slice(index + 1 - period, index + 1)),
  );
}

/** Rolling max/min over the `period` values ending at i (inclusive). */
function rollingExtreme(values, period, pick) {
  return values.map((_, index) =>
    index + 1 < period ? null : pick(...values.slice(index + 1 - period, index + 1)),
  );
}

/**
 * EMA seeded with the first value, matching pandas
 * `.ewm(span=period, adjust=False).mean()` so the JS and Python
 * implementations agree bar for bar.
 */
function ema(values, period) {
  const k = 2 / (period + 1);
  const series = [];
  for (const value of values) {
    series.push(series.length ? value * k + series.at(-1) * (1 - k) : value);
  }
  return series;
}

/**
 * Where the close sits inside the day's range, 0 (at the low) to 100 (at the
 * high). A zero-range day means close == high, so it scores 100.
 */
function closePosition(bar) {
  const range = bar.high - bar.low;
  return range <= 0 ? 100 : ((bar.close - bar.low) / range) * 100;
}

export function computeMetrics(bars) {
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const volumes = bars.map((bar) => bar.volume);

  const sma20 = rollingMean(closes, 20);
  const sma50 = rollingMean(closes, 50);
  const ema21 = ema(closes, 21);
  const highest20 = rollingExtreme(highs, 20, Math.max);
  const highest15 = rollingExtreme(highs, 15, Math.max);
  const lowest15 = rollingExtreme(lows, 15, Math.min);
  const avgVol50 = rollingMean(volumes, 50);

  return bars.map((bar, index) => {
    const priorClose = index > 0 ? closes[index - 1] : null;
    const base = closes[index - PARAMS.threeMonthBars];
    return {
      date: bar.date,
      close: bar.close,
      sma20: sma20[index],
      sma50: sma50[index],
      ema21: ema21[index],
      highest20: highest20[index],
      highest15: highest15[index],
      lowest15: lowest15[index],
      avgVol50: avgVol50[index],
      rvol: avgVol50[index] ? bar.volume / avgVol50[index] : null,
      range15Pct:
        highest15[index] == null ? null : ((highest15[index] - lowest15[index]) / bar.close) * 100,
      closePosition: closePosition(bar),
      dayChangePct: priorClose ? (bar.close / priorClose - 1) * 100 : null,
      threeMonthPct: base ? (bar.close / base - 1) * 100 : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Rule 2 — Breakout
// ---------------------------------------------------------------------------

/**
 * A day is a breakout when it closes above *yesterday's* Highest_20D on
 * expanded volume and finishes in the upper part of its range. That prior
 * 20-day high is the pivot the breakout has to keep defending afterwards.
 */
export function breakoutAt(metrics, index) {
  if (index < 1) return null;
  const pivot = metrics[index - 1].highest20;
  const { close, rvol, closePosition: position } = metrics[index];
  if (pivot == null || rvol == null) return null;
  const valid =
    close > pivot &&
    rvol >= PARAMS.breakoutMinRvol &&
    position >= PARAMS.breakoutMinClosePosition;
  return { valid, pivot, rvol, closePosition: position, date: metrics[index].date };
}

/** Most recent valid breakout in the `lookback` days ending yesterday. */
function lastBreakoutWithin(metrics, index, lookback) {
  for (let cursor = index - 1; cursor >= Math.max(1, index - lookback); cursor -= 1) {
    const signal = breakoutAt(metrics, cursor);
    if (signal?.valid) return { ...signal, index: cursor, daysAgo: index - cursor };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 1 — Setup criteria
//
// Deliberately separate from the assigned main state: Tightness keys off
// "meets the Setup criteria", which a Breakout day can also do.
// ---------------------------------------------------------------------------

export function setupCriteriaAt(metrics, index) {
  const m = metrics[index];
  if (m.sma20 == null || m.sma50 == null || m.highest20 == null) return null;
  if (m.range15Pct == null || m.threeMonthPct == null) return null;

  // Percent below the 20-day high, i.e. 0% sitting right on the pivot.
  const distanceToHighPct = ((m.highest20 - m.close) / m.highest20) * 100;
  const met =
    m.close > m.sma20 &&
    m.close > m.sma50 &&
    distanceToHighPct >= 0 &&
    distanceToHighPct <= PARAMS.setupMaxDistanceToHighPct &&
    m.range15Pct <= PARAMS.setupMaxRange15Pct &&
    m.threeMonthPct > PARAMS.setupMinThreeMonthPct;
  return { met, distanceToHighPct };
}

// ---------------------------------------------------------------------------
// Rule 5b — Spring (Wyckoff undercut & rally)
// ---------------------------------------------------------------------------

export function springAt(metrics, bars, index) {
  let found = null;

  const earliest = Math.max(5, index - (PARAMS.springLookbackDays - 1));
  for (let sweep = earliest; sweep <= index; sweep += 1) {
    // Support is the lowest low of the five days *preceding* the undercut.
    const support = Math.min(...bars.slice(sweep - 5, sweep).map((bar) => bar.low));
    const undercutPct = ((bars[sweep].low - support) / support) * 100;
    if (undercutPct >= 0 || undercutPct < PARAMS.springUndercutMinPct) continue;

    const lastReclaim = Math.min(index, sweep + PARAMS.springReclaimWindow);
    for (let reclaim = sweep + 1; reclaim <= lastReclaim; reclaim += 1) {
      const r = metrics[reclaim];
      const reclaimed =
        bars[reclaim].close > support &&
        r.dayChangePct != null &&
        r.dayChangePct >= PARAMS.springMinGainPct &&
        r.closePosition >= PARAMS.springMinClosePosition &&
        r.rvol != null &&
        r.rvol >= PARAMS.springMinRvol;
      if (!reclaimed) continue;

      // Still working: price above the reclaim day's close, and support has
      // not been given back since.
      const heldSupport = bars
        .slice(reclaim + 1, index + 1)
        .every((bar) => bar.close >= support * PARAMS.springSupportLossBuffer);
      if (metrics[index].close > bars[reclaim].close && heldSupport) {
        found = {
          springDate: bars[sweep].date,
          reclaimDate: bars[reclaim].date,
          support,
          undercutPct,
          daysSinceReclaim: index - reclaim,
        };
      }
      break; // first qualifying reclaim settles this sweep
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Rules 3, 4 and the precedence ladder
// ---------------------------------------------------------------------------

export const MAIN_STATES = ["fakeout", "breakout", "holding", "setup", "watch"];

/**
 * Classify the bar at `index` (defaults to the latest).
 * Returns null when there is not enough history to evaluate the rules.
 */
export function classify(bars, index = bars.length - 1) {
  // The 3-month lookback is the longest requirement (63 bars back), and it
  // subsumes the 50-day volume average.
  if (index < PARAMS.threeMonthBars || index >= bars.length) return null;

  const metrics = computeMetrics(bars);
  const m = metrics[index];

  const today = breakoutAt(metrics, index);
  const setup = setupCriteriaAt(metrics, index);
  if (!setup) return null;

  const holdingBreakout = lastBreakoutWithin(metrics, index, PARAMS.holdingLookbackDays);
  const fakeoutBreakout = lastBreakoutWithin(metrics, index, PARAMS.fakeoutLookbackDays);
  const priorHigh20 = metrics[index - 1].highest20;

  // 4A — intraday rejection: poked through the pivot, closed back under it,
  // on heavy volume and in the lower half of the day.
  const rejectedIntraday =
    priorHigh20 != null &&
    m.rvol != null &&
    bars[index].high > priorHigh20 &&
    m.close < priorHigh20 &&
    m.rvol >= PARAMS.fakeoutMinRvol &&
    m.closePosition < PARAMS.fakeoutMaxClosePosition;

  // 4B — a breakout in the last 1–5 days that has since lost its pivot.
  const lostRecentPivot = Boolean(fakeoutBreakout && m.close < fakeoutBreakout.pivot);

  const holding = Boolean(
    holdingBreakout &&
      m.close >= holdingBreakout.pivot &&
      m.close >= m.ema21 * PARAMS.holdingEma21Buffer,
  );

  const mainState = rejectedIntraday || lostRecentPivot
    ? "fakeout"
    : today?.valid
      ? "breakout"
      : holding
        ? "holding"
        : setup.met
          ? "setup"
          : "watch";

  const spring = springAt(metrics, bars, index);

  return {
    date: m.date,
    mainState,
    // Secondary tags — independent of the main state, per the spec.
    springTag: Boolean(spring),
    tightnessTag: setup.met && m.range15Pct < PARAMS.tightnessMaxRange15Pct,
    spring,

    // Why it landed where it did, so the page can show its work.
    setupCriteriaMet: setup.met,
    fakeoutReason: rejectedIntraday ? "intraday-rejection" : lostRecentPivot ? "lost-pivot" : null,
    pivot: today?.valid ? today.pivot : (holdingBreakout ?? fakeoutBreakout)?.pivot ?? m.highest20,
    breakoutDate: (today?.valid ? today : holdingBreakout ?? fakeoutBreakout)?.date ?? null,
    breakoutDaysAgo: today?.valid ? 0 : (holdingBreakout ?? fakeoutBreakout)?.daysAgo ?? null,

    close: m.close,
    sma20: m.sma20,
    sma50: m.sma50,
    ema21: m.ema21,
    highest20: m.highest20,
    rvol: m.rvol,
    closePosition: m.closePosition,
    range15Pct: m.range15Pct,
    threeMonthPct: m.threeMonthPct,
    distanceToHighPct: setup.distanceToHighPct,
    avgVol50: m.avgVol50,
  };
}

// ---------------------------------------------------------------------------
// Rule 6 — Leaders
// ---------------------------------------------------------------------------

/**
 * Eligible pool is Setup / Breakout / Holding, plus stocks that would
 * otherwise be Watch but carry a live Spring tag. Fakeout is disqualified
 * outright, Spring tag or not.
 */
export function isLeaderEligible(stock) {
  if (stock.mainState === "fakeout") return false;
  if (stock.mainState === "watch") return Boolean(stock.springTag);
  return true;
}

export function leaderScore(stock, etfWeightPct = 0) {
  return (stock.marketCap ?? 0) * (1 + etfWeightPct / PARAMS.leaderWeightDivisor);
}

/**
 * Top `leaderLimit` names, largest first by market cap weighted up for ETF
 * membership. `weightOf` returns the stock's weight in the cluster's ETF.
 */
export function pickLeaders(stocks, weightOf = (stock) => stock.etfWeight ?? 0) {
  return stocks
    .filter(isLeaderEligible)
    .map((stock) => ({ stock, score: leaderScore(stock, weightOf(stock)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PARAMS.leaderLimit)
    .map((entry) => entry.stock);
}
