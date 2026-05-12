const JSZip = require("jszip");
let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  const args = JSON.parse(buf);
  process.stdout.write(JSON.stringify({ echo: args, jszip_loaded: typeof JSZip === "function" }));
});
