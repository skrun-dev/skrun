import { z } from "zod";

/** The shortest retention an agent's state can have, in days. */
export const STATE_TTL_MIN_DAYS = 1;
/** The longest retention an agent's state can have, in days. */
export const STATE_TTL_MAX_DAYS = 365;

export const StateConfigSchema = z.object({
  /** `none` unless the agent asks for state: an agent remembers nothing by default. */
  type: z.enum(["kv", "none"]).default("none"),
  /**
   * Who shares one notebook. `per_caller` (the default): each caller of the agent
   * reads and writes only its own. `shared`: one notebook for every caller.
   */
  scope: z.enum(["shared", "per_caller"]).default("per_caller"),
  /**
   * How long a notebook lives after its last write. The schema accepts any number of
   * days, so that a version already published stays runnable; the server reads the
   * value through `stateTtlDays`, which bounds it.
   */
  ttl: z
    .string()
    .regex(/^\d+d$/, 'TTL must be in days (e.g., "30d")')
    .default("30d"),
});

export type StateConfig = z.infer<typeof StateConfigSchema>;

/**
 * The number of days a `ttl` names, as written: not bounded. A run of digits too
 * long for a double reads as Infinity; a value that does not start with digits, as
 * NaN. The one reading of a `ttl`, shared by the two behaviours that decide from
 * it: `validateAgent` refuses a value outside the bounds before anything is
 * published, `stateTtlDays` brings it back to the nearest bound when it runs.
 */
export function stateTtlRawDays(ttl: string): number {
  return Number.parseInt(ttl, 10);
}

/**
 * The retention a `ttl` stands for, in days, bounded to
 * [STATE_TTL_MIN_DAYS, STATE_TTL_MAX_DAYS]: a value below the floor reads as the
 * floor, a value above the ceiling — however large — as the ceiling. The input is
 * expected in the schema's `<digits>d` form.
 */
export function stateTtlDays(ttl: string): number {
  // Infinity clamps to the ceiling.
  const days = stateTtlRawDays(ttl);
  if (Number.isNaN(days)) return STATE_TTL_MIN_DAYS;
  return Math.min(Math.max(days, STATE_TTL_MIN_DAYS), STATE_TTL_MAX_DAYS);
}
