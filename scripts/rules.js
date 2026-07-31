/**
 * Single source of truth for the scanner's state definitions.
 *
 * Nothing else in this repo is allowed to decide what "Setup" or "Fakeout"
 * means. The sync script computes states here and writes them into the feed;
 * the page only renders what it is given. tests/rules.test.mjs pins each rule
 * with a fixture, and tests/test_rules_parity.py pins this file against the
 * pandas reference.
 *
 * Bars are daily OHLCV, oldest first:
 *   { date, open, high, low, close, volume }
 */

// ---------------------------------------------------------------------------
// Parameter sets
//
// Switch presets to compare what the same day looks like under different
// thresholds. Nothing outside this block is a tunable number.
// ---------------------------------------------------------------------------

/**
 * Deepvue + Stockbee. The working default.
 *
 * Sourced numbers:
 *  - Tightness uses a normalised volatility reading rather than a raw range
 *    percentage, the way Deepvue's RMV does. Deepvue call anything under 15
 *    tight and their Tight Range preset uses under 10.
 *  - Close position 70: Deepvue's Daily Closing Range calls >70% "closed near
 *    the highs", and Stockbee's 4% breakout requires the close within 30% of
 *    the day's high. Same number from both.
 *  - Breakout also wants volume above the prior day, which is Stockbee's rule.
 *  - Holding looks back 5 days, the length of a Stockbee momentum burst, and
 *    trails the 21EMA, which is the moving average in Deepvue's "MA aligned".
 *  - Setup gates on RS Rating 85 rather than a raw 3-month return, which is
 *    how Deepvue's swing screens rank momentum.
 *  - Volume dry-up during the base is the part of a VCP that a range
 *    percentage alone cannot see.
 */
const DEEPVUE_STOCKBEE = {
  // Setup
  setupRequireMaStack: true, // close > SMA20 > SMA50
  setupMaxDistanceToHighPct: 5,
  setupMaxRmv: 15,
  // AvgVol(10) / AvgVol(50) must be *below* the norm. Deepvue and Stockbee
  // only say volume dries up during the base without giving a number, so this
  // is the literal reading rather than an invented cutoff.
  setupMaxVolumeDryUp: 1.0,
  setupMinRsRating: 85,
  setupMinThreeMonthPct: 0, // sanity floor only; RS does the ranking

  // Breakout
  breakoutMinRvol: 1.5,
  breakoutMinClosePosition: 70,
  breakoutRequireVolumeAbovePriorDay: true,

  // Holding
  holdingLookbackDays: 5,
  holdingEma21Buffer: 0.98,

  // Fakeout
  fakeoutMinRvol: 1.5,
  fakeoutMaxClosePosition: 50,
  fakeoutLookbackDays: 5,

  // Tightness tag
  tightnessMaxRmv: 10,

  // Spring. Wyckoff is not a Deepvue or Stockbee pattern, so the undercut
  // side keeps Vic's numbers; the reclaim day is required to be a Stockbee
  // 4% momentum-burst day, which is what gives it an external definition.
  springLookbackDays: 12,
  springUndercutMinPct: -5,
  springReclaimWindow: 3,
  springMinGainPct: 4,
  springMinClosePosition: 70,
  springRequireVolumeAbovePriorDay: true,
  springMinRvol: 1.15,
  springSupportLossBuffer: 0.98,

  // Leaders
  leaderLimit: 3,
  leaderWeightDivisor: 5,

  // Shared windows
  threeMonthBars: 63,
  // 60, not 15: a window close to the longest ATR period pins ~45% of the
  // universe at exactly 0 or 100, because the smoothed series barely moves
  // inside it. At 60 the reading spreads evenly across the range.
  rmvLookback: 60,
  rmvAtrPeriods: [5, 10, 15],
  volumeDryUpFast: 10,
  volumeDryUpSlow: 50,
};

/**
 * The first written spec, kept so the two can be diffed on the same data.
 * Absolute 15-day range instead of a normalised reading, no volume dry-up,
 * no RS gate, looser close position, 10-day Holding window.
 */
const SPEC_V1 = {
  ...DEEPVUE_STOCKBEE,
  setupRequireMaStack: false,
  setupMaxRmv: null,
  setupMaxRange15Pct: 12,
  setupMaxVolumeDryUp: null,
  setupMinRsRating: null,
  setupMinThreeMonthPct: 8,
  breakoutMinClosePosition: 60,
  breakoutRequireVolumeAbovePriorDay: false,
  holdingLookbackDays: 10,
  tightnessMaxRmv: null,
  tightnessMaxRange15Pct: 8,
  springUndercutMinPct: -6,
  springReclaimWindow: 5,
  springMinClosePosition: 45,
  springRequireVolumeAbovePriorDay: false,
};

export const PRESETS = {
  "deepvue-stockbee": DEEPVUE_STOCKBEE,
  "spec-v1": SPEC_V1,
};

export const DEFAULT_PRESET = "deepvue-stockbee";
export const PARAMS = PRESETS[DEFAULT_PRESET];

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
 * True range as a percentage of the close.
 *
 * Absolute true range drifts upward simply because the price is rising, which
 * would make a steadily trending stock look like it is expanding when its
 * behaviour has not changed. Dividing by the close removes that, and makes the
 * reading comparable between a $10 and a $500 stock.
 */
function trueRanges(bars) {
  return bars.map((bar, index) => {
    const priorClose = index === 0 ? bar.close : bars[index - 1].close;
    const range = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - priorClose),
      Math.abs(bar.low - priorClose),
    );
    return (range / bar.close) * 100;
  });
}

/**
 * Relative Measured Volatility, 0 (tightest) to 100 (most volatile).
 *
 * Deepvue do not publish their formula. This follows their description:
 * average several ATR lookbacks into one volatility reading, then min-max
 * normalise it inside a trailing window so the scale is relative to the
 * stock's own recent behaviour rather than an absolute percentage. That
 * normalisation is the whole point — an absolute range threshold silently
 * excludes high-ADR names and waves through sleepy ones.
 */
function rmvSeries(bars, params) {
  const ranges = trueRanges(bars);
  const atrs = params.rmvAtrPeriods.map((period) => rollingMean(ranges, period));

  const measured = bars.map((_, index) => {
    const values = atrs.map((series) => series[index]);
    return values.some((value) => value == null) ? null : mean(values);
  });

  return measured.map((value, index) => {
    if (value == null || index + 1 < params.rmvLookback) return null;
    const window = measured.slice(index + 1 - params.rmvLookback, index + 1);
    if (window.some((item) => item == null)) return null;
    const low = Math.min(...window);
    const high = Math.max(...window);
    // A window with no meaningful spread is as tight as it gets. Without this
    // the division blows tiny floating-point differences up into noise, which
    // is exactly the case for a stock that has gone completely quiet.
    if (high - low <= high * 1e-6) return 0;
    return Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
  });
}

/**
 * Where the close sits inside the day's range, 0 (at the low) to 100 (at the
 * high). A zero-range day means close == high, so it scores 100.
 */
function closePosition(bar) {
  const range = bar.high - bar.low;
  return range <= 0 ? 100 : ((bar.close - bar.low) / range) * 100;
}

export function computeMetrics(bars, params = PARAMS) {
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
  const avgVol50 = rollingMean(volumes, params.volumeDryUpSlow);
  const avgVolFast = rollingMean(volumes, params.volumeDryUpFast);
  const rmv = rmvSeries(bars, params);

  return bars.map((bar, index) => {
    const priorClose = index > 0 ? closes[index - 1] : null;
    const base = closes[index - params.threeMonthBars];
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
      // < 1 means the base is drying up, which is the half of a VCP that a
      // price range on its own cannot show.
      volumeDryUp: avgVol50[index] ? avgVolFast[index] / avgVol50[index] : null,
      volumeAbovePriorDay: index > 0 ? bar.volume > bars[index - 1].volume : false,
      rmv: rmv[index],
      range15Pct:
        highest15[index] == null ? null : ((highest15[index] - lowest15[index]) / bar.close) * 100,
      closePosition: closePosition(bar),
      dayChangePct: priorClose ? (bar.close / priorClose - 1) * 100 : null,
      threeMonthPct: base ? (bar.close / base - 1) * 100 : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Breakout
// ---------------------------------------------------------------------------

/**
 * A day is a breakout when it closes above *yesterday's* Highest_20D on
 * expanded volume and finishes near the top of its range. That prior 20-day
 * high is the pivot the breakout has to keep defending afterwards.
 */
export function breakoutAt(metrics, index, params = PARAMS) {
  if (index < 1) return null;
  const pivot = metrics[index - 1].highest20;
  const m = metrics[index];
  if (pivot == null || m.rvol == null) return null;
  const valid =
    m.close > pivot &&
    m.rvol >= params.breakoutMinRvol &&
    m.closePosition >= params.breakoutMinClosePosition &&
    (!params.breakoutRequireVolumeAbovePriorDay || m.volumeAbovePriorDay);
  return { valid, pivot, rvol: m.rvol, closePosition: m.closePosition, date: m.date };
}

/** Most recent valid breakout in the `lookback` days ending yesterday. */
function lastBreakoutWithin(metrics, index, lookback, params) {
  for (let cursor = index - 1; cursor >= Math.max(1, index - lookback); cursor -= 1) {
    const signal = breakoutAt(metrics, cursor, params);
    if (signal?.valid) return { ...signal, index: cursor, daysAgo: index - cursor };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Setup criteria
//
// Deliberately separate from the assigned main state: Tightness keys off
// "meets the Setup criteria", which a Breakout day can also do.
// ---------------------------------------------------------------------------

export function setupCriteriaAt(metrics, index, params = PARAMS) {
  const m = metrics[index];
  if (m.sma20 == null || m.sma50 == null || m.highest20 == null) return null;
  if (m.threeMonthPct == null) return null;

  // Percent below the 20-day high, i.e. 0% sitting right on the pivot.
  const distanceToHighPct = ((m.highest20 - m.close) / m.highest20) * 100;

  const trendOk = params.setupRequireMaStack
    ? m.close > m.sma20 && m.sma20 > m.sma50
    : m.close > m.sma20 && m.close > m.sma50;

  const tightOk =
    params.setupMaxRmv != null
      ? m.rmv != null && m.rmv <= params.setupMaxRmv
      : m.range15Pct != null && m.range15Pct <= params.setupMaxRange15Pct;

  const dryUpOk =
    params.setupMaxVolumeDryUp == null ||
    (m.volumeDryUp != null && m.volumeDryUp < params.setupMaxVolumeDryUp);

  const met =
    trendOk &&
    distanceToHighPct >= 0 &&
    distanceToHighPct <= params.setupMaxDistanceToHighPct &&
    tightOk &&
    dryUpOk &&
    m.threeMonthPct > params.setupMinThreeMonthPct;

  return { met, distanceToHighPct };
}

// ---------------------------------------------------------------------------
// Spring (Wyckoff undercut & rally)
// ---------------------------------------------------------------------------

export function springAt(metrics, bars, index, params = PARAMS) {
  let found = null;

  const earliest = Math.max(5, index - (params.springLookbackDays - 1));
  for (let sweep = earliest; sweep <= index; sweep += 1) {
    // Support is the lowest low of the five days *preceding* the undercut.
    const support = Math.min(...bars.slice(sweep - 5, sweep).map((bar) => bar.low));
    const undercutPct = ((bars[sweep].low - support) / support) * 100;
    if (undercutPct >= 0 || undercutPct < params.springUndercutMinPct) continue;

    const lastReclaim = Math.min(index, sweep + params.springReclaimWindow);
    for (let reclaim = sweep + 1; reclaim <= lastReclaim; reclaim += 1) {
      const r = metrics[reclaim];
      const reclaimed =
        bars[reclaim].close > support &&
        r.dayChangePct != null &&
        r.dayChangePct >= params.springMinGainPct &&
        r.closePosition >= params.springMinClosePosition &&
        r.rvol != null &&
        r.rvol >= params.springMinRvol &&
        (!params.springRequireVolumeAbovePriorDay || r.volumeAbovePriorDay);
      if (!reclaimed) continue;

      // Still working: price above the reclaim day's close, and support has
      // not been given back since.
      const heldSupport = bars
        .slice(reclaim + 1, index + 1)
        .every((bar) => bar.close >= support * params.springSupportLossBuffer);
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
// Holding, Fakeout and the precedence ladder
// ---------------------------------------------------------------------------

export const MAIN_STATES = ["fakeout", "breakout", "holding", "setup", "watch"];

/**
 * Classify the bar at `index` (defaults to the latest).
 * Returns null when there is not enough history to evaluate the rules.
 *
 * The RS gate is not applied here — RS is a rank across the universe, so the
 * scanner applies it afterwards with applyRsRating().
 */
export function classify(bars, index = bars.length - 1, params = PARAMS) {
  // The 3-month lookback is the longest requirement (63 bars back), and it
  // subsumes the 50-day volume average.
  if (index < params.threeMonthBars || index >= bars.length) return null;

  const metrics = computeMetrics(bars, params);
  const m = metrics[index];

  const today = breakoutAt(metrics, index, params);
  const setup = setupCriteriaAt(metrics, index, params);
  if (!setup) return null;

  const holdingBreakout = lastBreakoutWithin(metrics, index, params.holdingLookbackDays, params);
  const fakeoutBreakout = lastBreakoutWithin(metrics, index, params.fakeoutLookbackDays, params);
  const priorHigh20 = metrics[index - 1].highest20;

  // Intraday rejection: poked through the pivot, closed back under it, on
  // heavy volume and in the lower half of the day.
  const rejectedIntraday =
    priorHigh20 != null &&
    m.rvol != null &&
    bars[index].high > priorHigh20 &&
    m.close < priorHigh20 &&
    m.rvol >= params.fakeoutMinRvol &&
    m.closePosition < params.fakeoutMaxClosePosition;

  // A breakout in the last 1-5 days that has since lost its pivot.
  const lostRecentPivot = Boolean(fakeoutBreakout && m.close < fakeoutBreakout.pivot);

  const holding = Boolean(
    holdingBreakout &&
      m.close >= holdingBreakout.pivot &&
      m.close >= m.ema21 * params.holdingEma21Buffer,
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

  const spring = springAt(metrics, bars, index, params);

  return {
    date: m.date,
    mainState,
    // Secondary tags — independent of the main state.
    springTag: Boolean(spring),
    tightnessTag: setup.met && isTight(m, params),
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
    rmv: m.rmv,
    volumeDryUp: m.volumeDryUp,
    closePosition: m.closePosition,
    range15Pct: m.range15Pct,
    threeMonthPct: m.threeMonthPct,
    distanceToHighPct: setup.distanceToHighPct,
    avgVol50: m.avgVol50,
  };
}

function isTight(m, params) {
  return params.tightnessMaxRmv != null
    ? m.rmv != null && m.rmv < params.tightnessMaxRmv
    : m.range15Pct != null && m.range15Pct < params.tightnessMaxRange15Pct;
}

/**
 * Apply the RS Rating gate once the universe has been ranked.
 *
 * RS can only ever remove Setup status, and Setup sits below Fakeout,
 * Breakout and Holding in the ladder, so this is exact without re-running
 * the rules over the bars.
 */
export function applyRsRating(verdict, rsRating, params = PARAMS) {
  if (params.setupMinRsRating == null) return verdict;
  const passes = rsRating != null && rsRating >= params.setupMinRsRating;
  if (passes) return verdict;

  const setupCriteriaMet = false;
  return {
    ...verdict,
    setupCriteriaMet,
    tightnessTag: false,
    mainState: verdict.mainState === "setup" ? "watch" : verdict.mainState,
  };
}

// ---------------------------------------------------------------------------
// Leaders
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

export function leaderScore(stock, etfWeightPct = 0, params = PARAMS) {
  return (stock.marketCap ?? 0) * (1 + etfWeightPct / params.leaderWeightDivisor);
}

/**
 * Top `leaderLimit` names, largest first by market cap weighted up for ETF
 * membership. `weightOf` returns the stock's weight in the cluster's ETF.
 */
export function pickLeaders(stocks, weightOf = (stock) => stock.etfWeight ?? 0, params = PARAMS) {
  return stocks
    .filter(isLeaderEligible)
    .map((stock) => ({ stock, score: leaderScore(stock, weightOf(stock), params) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.leaderLimit)
    .map((entry) => entry.stock);
}
