// Default the operator dashboard OFF for the api test process.
//
// The dashboard is an opt-in surface; most of the suite builds `createApp`
// without caring about it. Leaving it enabled-by-default would resolve the
// fallback root "../web/dist" (often absent under the test cwd) and emit a
// one-line missing-dir warning on every `createApp`. Defaulting to off keeps
// the suite quiet; dashboard tests opt in explicitly per-`describe` by setting
// SKRUN_DASHBOARD="on" + SKRUN_DASHBOARD_DIR=<fixture> (with afterEach restore).
process.env.SKRUN_DASHBOARD ??= "off";

// Enable the dev-token admin shortcut for the api test process — the suite is
// full of `Bearer dev-token` requests that expect admin. Vitest sets
// NODE_ENV=test (allowlisted) so the createApp dev-auth interlock won't trip.
process.env.SKRUN_DEV_AUTH ??= "1";
