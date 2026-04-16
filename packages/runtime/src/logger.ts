import pino from "pino";

export type { Logger } from "pino";

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

export function createLogger(name: string, destination?: pino.DestinationStream): pino.Logger {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() ?? "info";
  const level = VALID_LEVELS.has(envLevel) ? envLevel : "info";

  return pino(
    {
      name: `skrun:${name}`,
      level,
      redact: {
        paths: ["callerKeys.*", "details.callerKeys.*"],
        censor: "[REDACTED]",
      },
    },
    destination ?? pino.destination(1),
  );
}
