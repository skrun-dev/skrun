import sys
import json
import pandas as pd

args = json.loads(sys.stdin.read())
print(json.dumps({"echo": args, "pandas_version": pd.__version__}))
