// biome-ignore lint/correctness/noUnusedVariables: fixture validates that scripts can import Node stdlib without npm deps; the resolution itself is the test
const fs = require("node:fs");
// biome-ignore lint/correctness/noUnusedVariables: fixture validates that scripts can import Node stdlib without npm deps; the resolution itself is the test
const path = require("node:path");
let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ echo: JSON.parse(buf), stdlib_only: true }));
});
