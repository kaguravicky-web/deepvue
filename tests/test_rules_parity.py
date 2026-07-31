"""Proves scripts/rules_reference.py agrees with scripts/rules.js.

The JS module is the engine that builds the published feed; the Python module
is the reference. If they ever drift, this fails.

Both parameter presets are checked, so a change that only shows up under one
threshold set cannot slip through.

    python tests/test_rules_parity.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from rules_reference import PRESETS, classify_ticker  # noqa: E402

FLOAT_FIELDS = [
    "close_position",
    "rvol",
    "rmv",
    "volume_dry_up",
    "range15_pct",
    "three_month_pct",
    "distance_to_high_pct",
    "ema21",
    "sma20",
    "sma50",
]
BOOL_FIELDS = ["spring_tag", "tightness_tag", "setup_criteria_met"]
TOLERANCE = 1e-9


def load_fixtures() -> dict:
    result = subprocess.run(
        ["node", str(ROOT / "tests" / "export-fixtures.mjs")],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    )
    return json.loads(result.stdout)


def compare(ticker: str, preset: str, expected: dict, actual: dict) -> list[str]:
    failures = []
    label = f"{preset}/{ticker}"

    if actual["main_state"] != expected["main_state"]:
        failures.append(
            f"{label}.main_state: js={expected['main_state']} py={actual['main_state']}"
        )
    if actual["fakeout_reason"] != expected["fakeout_reason"]:
        failures.append(
            f"{label}.fakeout_reason: js={expected['fakeout_reason']} "
            f"py={actual['fakeout_reason']}"
        )
    for field in BOOL_FIELDS:
        if bool(actual[field]) != bool(expected[field]):
            failures.append(f"{label}.{field}: js={expected[field]} py={actual[field]}")
    for field in FLOAT_FIELDS:
        left, right = expected[field], actual[field]
        if left is None or right is None:
            if left is not right:
                failures.append(f"{label}.{field}: js={left!r} py={right!r}")
            continue
        if abs(float(right) - float(left)) > TOLERANCE:
            failures.append(f"{label}.{field}: js={left!r} py={right!r}")
    return failures


def main() -> int:
    fixtures = load_fixtures()
    frame = pd.DataFrame(fixtures["rows"])
    frames = {ticker: group for ticker, group in frame.groupby("ticker", sort=False)}

    failures = []
    checked = 0
    summary = []

    for preset, cases in fixtures["expected"].items():
        params = PRESETS[preset]
        for ticker, expected in cases.items():
            actual = classify_ticker(frames[ticker], params)
            if actual is None:
                failures.append(f"{preset}/{ticker}: pandas returned no verdict")
                continue
            failures += compare(ticker, preset, expected, actual)
            checked += 1
            tags = [name for name in ("spring_tag", "tightness_tag") if expected[name]]
            summary.append((preset, ticker, expected["main_state"], " ".join(tags)))

    if failures:
        print(f"FAIL - {len(failures)} mismatch(es) between rules.js and rules_reference.py")
        for line in failures:
            print(f"  {line}")
        return 1

    print(f"OK - {checked} fixture/preset combinations agree across both implementations")
    for preset, ticker, state, tags in summary:
        print(f"  {preset:<17} {ticker:<18} {state:<9} {tags}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
