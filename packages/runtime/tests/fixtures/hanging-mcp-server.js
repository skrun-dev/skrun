// MCP "server" fixture that never speaks the protocol. Used by the connect-
// timeout test to simulate a cold-start hang (e.g., a Chromium MCP server that
// fails to bootstrap). We start a long-lived setInterval so the subprocess
// stays alive and stdio remains open — the MCP client's connect() handshake
// will wait for the initialize response that never arrives.
const keepalive = setInterval(() => {}, 60_000);

// Best-effort cleanup if our parent disconnects stdio.
process.stdin.on("end", () => clearInterval(keepalive));
