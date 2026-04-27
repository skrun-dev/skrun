#!/usr/bin/env python3
"""Read a bank statement CSV and return its rows as JSON.

Input  (stdin JSON):  { csv_path }
Output (stdout JSON): { rows: [{...}] } | { error }
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import pandas as pd
except ImportError as e:
    print(json.dumps({
        "error": f"pandas not installed: {e}. Run: pip install -r requirements.txt"
    }))
    sys.exit(0)


def main() -> None:
    raw = sys.stdin.read()
    try:
        args = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid stdin JSON: {e}"}))
        return

    csv_path = args.get("csv_path")
    if not csv_path or not isinstance(csv_path, str):
        print(json.dumps({"error": "csv_path is required and must be a string"}))
        return

    p = Path(csv_path)
    if not p.exists() or not p.is_file():
        print(json.dumps({"error": f"csv_path not found or not a file: {csv_path}"}))
        return

    try:
        df = pd.read_csv(csv_path)
    except Exception as e:
        print(json.dumps({"error": f"failed to read CSV: {e}"}))
        return

    # Convert to JSON-safe records.
    rows = df.where(pd.notnull(df), None).to_dict(orient="records")
    clean_rows = []
    for r in rows:
        clean = {}
        for k, v in r.items():
            if v is None:
                clean[k] = None
            elif isinstance(v, (int, float, str, bool)):
                clean[k] = v
            else:
                try:
                    clean[k] = v.item()
                except AttributeError:
                    clean[k] = str(v)
        clean_rows.append(clean)

    print(json.dumps({"rows": clean_rows, "row_count": len(clean_rows)}, default=str))


if __name__ == "__main__":
    main()
