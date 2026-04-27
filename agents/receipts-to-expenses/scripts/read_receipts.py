#!/usr/bin/env python3
"""Scan a directory for `.txt` receipt files and return their content.

Input  (stdin JSON):  { receipts_dir }
Output (stdout JSON): { files: [{ filename, content }] }
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    raw = sys.stdin.read()
    try:
        args = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid stdin JSON: {e}"}))
        return

    receipts_dir = args.get("receipts_dir")
    if not receipts_dir or not isinstance(receipts_dir, str):
        print(json.dumps({"error": "receipts_dir is required and must be a string"}))
        return

    p = Path(receipts_dir)
    if not p.exists():
        # Empty / nonexistent dir is a valid "no receipts yet" state.
        print(json.dumps({"files": []}))
        return
    if not p.is_dir():
        print(json.dumps({"error": f"receipts_dir is not a directory: {receipts_dir}"}))
        return

    files = []
    for txt in sorted(p.rglob("*.txt")):
        try:
            content = txt.read_text(encoding="utf-8")
        except Exception:
            continue
        files.append({
            "filename": str(txt.relative_to(p)).replace("\\", "/"),
            "content": content,
        })

    print(json.dumps({"files": files}))


if __name__ == "__main__":
    main()
