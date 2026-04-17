// Test script that outputs the SKRUN_ALLOWED_HOSTS env var
// Used by script-provider.test.ts to verify env var passing
process.stdout.write(process.env.SKRUN_ALLOWED_HOSTS || "");
