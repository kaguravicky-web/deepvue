"""Proves scripts/rules_reference.py agrees with scripts/rules.mjs.

The JS module is the engine that builds the published feed; the Python module
is the reference. If they ever drift, this fails.

    node tests/export-fixtures.mjs > tests/fixtures.json
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

from rules_reference import classify_universe  # noqa: E402

FLOAT_FIELDS = [
    "close_position",
    "rvol",
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


def main() -> int:
    fixtures = load_fixtures()
    frame = pd.DataFrame(fixtures["rows"])
    states = classify_universe(frame)

    failures = []
    for ticker, expected in fixtures["expected"].items():
        if ticker not in states.index:
            failures.append(f"{ticker}: missing from the pandas output")
            continue
        actual = states.loc[ticker]

        if actual["main_state"] != expected["main_state"]:
            failures.append(
                f"{ticker}.main_state: js={expected['main_state']} py={actual['main_state']}"
            )
        if actual["fakeout_reason"] != expected["fakeout_reason"]:
            failures.append(
                f"{ticker}.fakeout_reason: js={expected['fakeout_reason']} "
                f"py={actual['fakeout_reason']}"
            )
        for field in BOOL_FIELDS:
            if bool(actual[field]) != bool(expected[field]):
                failures.append(
                    f"{ticker}.{field}: js={expected[field]} py={actual[field]}"
                )
        for field in FLOAT_FIELDS:
            if abs(float(actual[field]) - float(expected[field])) > TOLERANCE:
                failures.append(
                    f"{ticker}.{field}: js={expected[field]!r} py={actual[field]!r}"
                )

    if failures:
        print(f"FAIL — {len(failures)} mismatch(es) between rules.mjs and rules_reference.py")
        for line in failures:
            print(f"  {line}")
        return 1

    checked = len(fixtures["expected"])
    print(f"OK — {checked} fixtures agree across both implementations")
    for ticker, expected in fixtures["expected"].items():
        tags = [name for name in ("spring_tag", "tightness_tag") if expected[name]]
        print(f"  {ticker:<18} {expected['main_state']:<9} {' '.join(tags)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
