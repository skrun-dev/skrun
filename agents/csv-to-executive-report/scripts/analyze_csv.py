#!/usr/bin/env python3
"""Load a CSV and return a structured summary for the LLM.

Input  (stdin JSON):  { csv_path }
Output (stdout JSON): { columns, dtypes, row_count, numeric_stats, sample_rows } | { error }
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

    columns = list(df.columns)
    dtypes = {col: str(df[col].dtype) for col in columns}
    row_count = int(len(df))

    numeric_stats: dict[str, dict[str, float]] = {}
    for col in columns:
        if pd.api.types.is_numeric_dtype(df[col]):
            series = df[col].dropna()
            if len(series) == 0:
                continue
            numeric_stats[col] = {
                "min": float(series.min()),
                "max": float(series.max()),
                "mean": float(series.mean()),
                "sum": float(series.sum()),
                "count": int(len(series)),
            }

    # Sample rows — first 10. Convert to JSON-safe primitives.
    sample = df.head(10).where(pd.notnull(df.head(10)), None).to_dict(orient="records")
    # Ensure all values are JSON-serializable (cast np types to Python natives).
    sample_rows = []
    for row in sample:
        clean = {}
        for k, v in row.items():
            if v is None:
                clean[k] = None
            elif isinstance(v, (int, float, str, bool)):
                clean[k] = v
            else:
                # numpy types, timestamps, etc.
                try:
                    clean[k] = v.item()
                except AttributeError:
                    clean[k] = str(v)
        sample_rows.append(clean)

    print(json.dumps({
        "columns": columns,
        "dtypes": dtypes,
        "row_count": row_count,
        "numeric_stats": numeric_stats,
        "sample_rows": sample_rows,
    }, default=str))


if __name__ == "__main__":
    main()
