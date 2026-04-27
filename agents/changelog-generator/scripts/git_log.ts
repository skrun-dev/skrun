// Read commits from a local git repo OR a captured `.txt` dump file.
// Input (stdin JSON): { source, from_ref?, to_ref?, limit? }
// Output (stdout JSON): { commits: [{ hash, subject, author, date }], total }

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
});

process.stdin.on("end", () => {
  try {
    const args = JSON.parse(buf);
    const source: string = args.source;
    const fromRef: string | undefined = args.from_ref;
    const toRef: string = args.to_ref ?? "HEAD";
    const limit: number = typeof args.limit === "number" ? args.limit : 200;

    if (!source || typeof source !== "string") {
      throw new Error("source is required and must be a string");
    }
    if (!existsSync(source)) {
      throw new Error(`source not found: ${source}`);
    }

    const stat = statSync(source);
    let commits: Array<{ hash: string; subject: string; author: string; date: string }> = [];

    if (stat.isFile()) {
      // .txt dump mode — one `hash|subject|author|date` per line
      const lines = readFileSync(source, "utf-8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      commits = lines.flatMap((line) => {
        const parts = line.split("|");
        if (parts.length < 4) return [];
        const [hash, subject, author, date] = parts;
        return [
          {
            hash: hash!.trim(),
            subject: subject!.trim(),
            author: author!.trim(),
            date: date!.trim(),
          },
        ];
      });
    } else if (stat.isDirectory()) {
      // Real git repo mode
      const range = fromRef ? `${fromRef}..${toRef}` : toRef;
      const out = execFileSync(
        "git",
        [
          "-C",
          source,
          "log",
          "--pretty=format:%H|%s|%an|%ad",
          "--date=short",
          "-n",
          String(limit),
          range,
        ],
        { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
      );
      commits = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const parts = line.split("|");
          if (parts.length < 4) return [];
          const [hash, subject, author, date] = parts;
          return [{ hash: hash!, subject: subject!, author: author!, date: date! }];
        });
    } else {
      throw new Error(`source is neither a file nor a directory: ${source}`);
    }

    if (commits.length > limit) commits = commits.slice(0, limit);

    process.stdout.write(JSON.stringify({ commits, total: commits.length }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message, commits: [], total: 0 }));
  }
});
