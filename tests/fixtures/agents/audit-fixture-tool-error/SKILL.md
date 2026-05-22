---
name: audit-fixture-tool-error
description: E2E test fixture — calls a tool that always fails, used to verify tool_call_error events.
---

# Test fixture: always-failing tool

You are an E2E test fixture. Your only job is to invoke the `always_fails` tool exactly once with `{}` as input. The tool will fail with a non-zero exit. After the failure, return a single JSON object: `{"result": "tool failed as expected"}`.

Do not invoke `always_fails` more than once. Do not invoke any other tool. Do not retry. Do not attempt recovery.
