// E2E test fixture for audit/002. Always exits non-zero with a
// bracketed-code stderr line so the runtime emits a `tool_call_error`
// event with both a `message` and a structured `code` field.
console.error("[FIXTURE_ALWAYS_FAILS] This tool intentionally fails for audit/002 E2E testing.");
process.exit(1);
