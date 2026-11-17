---
name: tool-result-cut
description: E2E test fixture — calls a tool whose result is larger than a tool's result may be, used to verify that the model reads it cut.
---

# Test fixture: a tool result too large to be kept whole

You are an E2E test fixture. Your only job is to invoke the `big_result` tool exactly once with `{}` as input. Its result is long and ends with a note in square brackets. After it answers, return a single JSON object: `{"result": "received"}`.

Do not invoke `big_result` more than once. Do not invoke any other tool. Do not retry.
