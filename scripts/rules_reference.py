"""Pandas reference implementation of the scanner's state rules.

This is the same specification as ``scripts/rules.js``, which is what actually
produces the published feed. Keep the two in sync: the constants in ``PARAMS``
below mirror the JS module one for one, and the EMA is seeded the same way
(``adjust=False``) so both agree bar for bar.

Input frame columns::

    ticker, date, open, high, low, close, volume, market_cap, etf_weight

``market_cap`` and ``etf_weight`` are per-ticker constants and are only read
for the Leaders ranking.

Usage::

    states = classify_universe(df)          # one row per ticker, latest date
    leaders = pick_leaders(states)          # up to 3 names
"""

from __future__ import annotations

import numpy as np
import pandas as pd

PARAMS = {
    "setup_max_distance_to_high_pct": 5.0,
    "setup_max_range15_pct": 12.0,
    "setup_min_three_month_pct": 8.0,
    "breakout_min_rvol": 1.5,
    "breakout_min_close_position": 60.0,
    "holding_lookback_days": 10,
    "holding_ema21_buffer": 0.98,
    "fakeout_max_close_position": 50.0,
    "fakeout_min_rvol": 1.5,
    "fakeout_lookback_days": 5,
    "tightness_max_range15_pct": 8.0,
    "spring_lookback_days": 12,
    "spring_undercut_min_pct": -6.0,
    "spring_reclaim_window": 5,
    "spring_min_gain_pct": 4.0,
    "spring_min_close_position": 45.0,
    "spring_min_rvol": 1.15,
    "spring_support_loss_buffer": 0.98,
    "leader_limit": 3,
    "leader_weight_divisor": 5.0,
    "three_month_bars": 63,
}

MAIN_STATES = ("fakeout", "breakout", "holding", "setup", "watch")


# ---------------------------------------------------------------------------
# Base metrics
# ---------------------------------------------------------------------------


def compute_metrics(frame: pd.DataFrame) -> pd.DataFrame:
    """Add the base indicator columns to one ticker's frame (date ascending)."""
    out = frame.sort_values("date").reset_index(drop=True).copy()

    out["sma20"] = out["close"].rolling(20).mean()
    out["sma50"] = out["close"].rolling(50).mean()
    # adjust=False seeds the EMA with the first close, matching rules.js.
    out["ema21"] = out["close"].ewm(span=21, adjust=False).mean()

    out["highest_20d"] = out["high"].rolling(20).max()
    out["highest_15d"] = out["high"].rolling(15).max()
    out["lowest_15d"] = out["low"].rolling(15).min()
    out["avg_vol_50d"] = out["volume"].rolling(50).mean()

    out["rvol"] = out["volume"] / out["avg_vol_50d"]
    out["range15_pct"] = (out["highest_15d"] - out["lowest_15d"]) / out["close"] * 100

    daily_range = out["high"] - out["low"]
    # A zero-range day means the close is the high.
    out["close_position"] = np.where(
        daily_range > 0, (out["close"] - out["low"]) / daily_range * 100, 100.0
    )

    out["day_change_pct"] = out["close"].pct_change() * 100
    out["three_month_pct"] = (
        out["close"] / out["close"].shift(PARAMS["three_month_bars"]) - 1
    ) * 100

    # Yesterday's Highest_20D — the pivot a breakout has to clear and then hold.
    out["prior_high_20d"] = out["highest_20d"].shift(1)

    # Rule 2 evaluated on every bar, so the lookback rules can reuse it.
    out["is_breakout"] = (
        (out["close"] > out["prior_high_20d"])
        & (out["rvol"] >= PARAMS["breakout_min_rvol"])
        & (out["close_position"] >= PARAMS["breakout_min_close_position"])
    ).fillna(False)

    # Rule 1 as criteria, deliberately independent of the assigned main state:
    # Tightness keys off these conditions, which a Breakout bar can also meet.
    out["distance_to_high_pct"] = (
        (out["highest_20d"] - out["close"]) / out["highest_20d"] * 100
    )
    out["setup_criteria_met"] = (
        (out["close"] > out["sma20"])
        & (out["close"] > out["sma50"])
        & (out["distance_to_high_pct"] >= 0)
        & (out["distance_to_high_pct"] <= PARAMS["setup_max_distance_to_high_pct"])
        & (out["range15_pct"] <= PARAMS["setup_max_range15_pct"])
        & (out["three_month_pct"] > PARAMS["setup_min_three_month_pct"])
    ).fillna(False)

    return out


def _last_breakout_within(metrics: pd.DataFrame, index: int, lookback: int):
    """Most recent valid breakout in the `lookback` bars ending yesterday."""
    for cursor in range(index - 1, max(0, index - lookback) - 1, -1):
        if cursor >= 1 and bool(metrics.at[cursor, "is_breakout"]):
            return {
                "index": cursor,
                "pivot": float(metrics.at[cursor, "prior_high_20d"]),
                "date": metrics.at[cursor, "date"],
                "days_ago": index - cursor,
            }
    return None


# ---------------------------------------------------------------------------
# Rule 5b — Spring
# ---------------------------------------------------------------------------


def _find_spring(metrics: pd.DataFrame, index: int):
    """Latest Wyckoff undercut-and-rally that is still working, or None."""
    found = None
    earliest = max(5, index - (PARAMS["spring_lookback_days"] - 1))

    for sweep in range(earliest, index + 1):
        # Support is the lowest low of the five days preceding the undercut.
        support = float(metrics["low"].iloc[sweep - 5 : sweep].min())
        undercut_pct = (float(metrics.at[sweep, "low"]) - support) / support * 100
        if undercut_pct >= 0 or undercut_pct < PARAMS["spring_undercut_min_pct"]:
            continue

        last_reclaim = min(index, sweep + PARAMS["spring_reclaim_window"])
        for reclaim in range(sweep + 1, last_reclaim + 1):
            row = metrics.iloc[reclaim]
            reclaimed = (
                row["close"] > support
                and pd.notna(row["day_change_pct"])
                and row["day_change_pct"] >= PARAMS["spring_min_gain_pct"]
                and row["close_position"] >= PARAMS["spring_min_close_position"]
                and pd.notna(row["rvol"])
                and row["rvol"] >= PARAMS["spring_min_rvol"]
            )
            if not reclaimed:
                continue

            # Still working: above the reclaim day's close, support not given back.
            after = metrics["close"].iloc[reclaim + 1 : index + 1]
            held = bool(
                (after >= support * PARAMS["spring_support_loss_buffer"]).all()
            )
            if metrics.at[index, "close"] > row["close"] and held:
                found = {
                    "spring_date": metrics.at[sweep, "date"],
                    "reclaim_date": row["date"],
                    "support": support,
                    "undercut_pct": undercut_pct,
                    "days_since_reclaim": index - reclaim,
                }
            break  # first qualifying reclaim settles this sweep

    return found


# ---------------------------------------------------------------------------
# Rules 3, 4 and the precedence ladder
# ---------------------------------------------------------------------------


def classify_ticker(frame: pd.DataFrame) -> dict | None:
    """Classify one ticker on its most recent bar. None if history is too short."""
    metrics = compute_metrics(frame)
    index = len(metrics) - 1
    if index < PARAMS["three_month_bars"]:
        return None

    row = metrics.iloc[index]
    prior_high = row["prior_high_20d"]

    holding_bo = _last_breakout_within(metrics, index, PARAMS["holding_lookback_days"])
    fakeout_bo = _last_breakout_within(metrics, index, PARAMS["fakeout_lookback_days"])

    # 4A — poked through the pivot, closed back under it, heavy and weak.
    rejected_intraday = bool(
        pd.notna(prior_high)
        and pd.notna(row["rvol"])
        and row["high"] > prior_high
        and row["close"] < prior_high
        and row["rvol"] >= PARAMS["fakeout_min_rvol"]
        and row["close_position"] < PARAMS["fakeout_max_close_position"]
    )

    # 4B — a breakout in the last 1-5 days that has since lost its pivot.
    lost_pivot = bool(fakeout_bo and row["close"] < fakeout_bo["pivot"])

    holding = bool(
        holding_bo
        and row["close"] >= holding_bo["pivot"]
        and row["close"] >= row["ema21"] * PARAMS["holding_ema21_buffer"]
    )

    today_breakout = bool(row["is_breakout"])
    setup_met = bool(row["setup_criteria_met"])

    if rejected_intraday or lost_pivot:
        main_state = "fakeout"
    elif today_breakout:
        main_state = "breakout"
    elif holding:
        main_state = "holding"
    elif setup_met:
        main_state = "setup"
    else:
        main_state = "watch"

    spring = _find_spring(metrics, index)
    reference = holding_bo or fakeout_bo

    return {
        "ticker": frame["ticker"].iloc[0],
        "date": row["date"],
        "main_state": main_state,
        # Secondary tags — independent of the main state.
        "spring_tag": spring is not None,
        "tightness_tag": setup_met
        and bool(row["range15_pct"] < PARAMS["tightness_max_range15_pct"]),
        "setup_criteria_met": setup_met,
        "fakeout_reason": (
            "intraday-rejection"
            if rejected_intraday
            else "lost-pivot"
            if lost_pivot
            else None
        ),
        "pivot": float(prior_high) if today_breakout and pd.notna(prior_high)
        else (reference["pivot"] if reference else float(row["highest_20d"])),
        "breakout_date": row["date"] if today_breakout else (reference or {}).get("date"),
        "breakout_days_ago": 0 if today_breakout else (reference or {}).get("days_ago"),
        "spring_support": spring["support"] if spring else None,
        "spring_date": spring["spring_date"] if spring else None,
        "reclaim_date": spring["reclaim_date"] if spring else None,
        "close": float(row["close"]),
        "sma20": float(row["sma20"]),
        "sma50": float(row["sma50"]),
        "ema21": float(row["ema21"]),
        "highest_20d": float(row["highest_20d"]),
        "rvol": float(row["rvol"]),
        "close_position": float(row["close_position"]),
        "range15_pct": float(row["range15_pct"]),
        "three_month_pct": float(row["three_month_pct"]),
        "distance_to_high_pct": float(row["distance_to_high_pct"]),
        "market_cap": float(frame["market_cap"].iloc[-1])
        if "market_cap" in frame
        else np.nan,
        "etf_weight": float(frame["etf_weight"].iloc[-1])
        if "etf_weight" in frame
        else 0.0,
    }


def classify_universe(df: pd.DataFrame) -> pd.DataFrame:
    """Main state and secondary tags for every ticker on its latest bar."""
    rows = [
        result
        for _, frame in df.groupby("ticker", sort=False)
        if (result := classify_ticker(frame)) is not None
    ]
    if not rows:
        return pd.DataFrame(
            columns=["ticker", "main_state", "spring_tag", "tightness_tag"]
        )
    return pd.DataFrame(rows).set_index("ticker")


# ---------------------------------------------------------------------------
# Rule 6 — Leaders
# ---------------------------------------------------------------------------


def is_leader_eligible(row: pd.Series) -> bool:
    """Setup / Breakout / Holding qualify; Watch only with a live Spring tag.

    Fakeout is disqualified outright, Spring tag or not.
    """
    if row["main_state"] == "fakeout":
        return False
    if row["main_state"] == "watch":
        return bool(row["spring_tag"])
    return True


def pick_leaders(states: pd.DataFrame) -> pd.DataFrame:
    """Top names by market cap, weighted up for ETF membership. Max 3."""
    if states.empty:
        return states
    eligible = states[states.apply(is_leader_eligible, axis=1)].copy()
    if eligible.empty:
        return eligible
    eligible["leader_score"] = eligible["market_cap"].fillna(0) * (
        1 + eligible["etf_weight"].fillna(0) / PARAMS["leader_weight_divisor"]
    )
    return eligible.sort_values("leader_score", ascending=False).head(
        PARAMS["leader_limit"]
    )


if __name__ == "__main__":  # pragma: no cover - manual smoke run
    import sys

    source = sys.argv[1] if len(sys.argv) > 1 else "ohlcv.csv"
    frame = pd.read_csv(source, parse_dates=["date"])
    states = classify_universe(frame)
    print(states["main_state"].value_counts().to_string())
    print()
    print(
        states[["main_state", "spring_tag", "tightness_tag", "range15_pct", "rvol"]]
        .sort_values("main_state")
        .to_string()
    )
    print()
    print("Leaders:", ", ".join(pick_leaders(states).index))
