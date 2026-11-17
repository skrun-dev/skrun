import { Component, type ReactNode, useId } from "react";
import { useUsage } from "../../lib/api-client";
import { IconClock, IconError } from "../shared/icons";
import { Card, Pill } from "../shared/ui";

// The account's usage, on the home page: the plan whose thresholds apply and,
// for each bound the server sets and the strip shows, what the account uses of
// it now. A bound the server does not set is not shown; a value the strip
// cannot read is left out, with whatever needs it. With no cell to show, on
// any answer but a 200, or on any error while it renders, there is no strip at
// all — nothing is made up.

type Tone = "neutral" | "amber" | "red";

/** The runs in progress, as read. */
interface Seats {
  inUse: number;
  limit: number;
}

/** The compute of the window, as read — with the window's end, which the reset shows. */
interface Compute {
  used: number;
  limit: number;
  windowEnd: string;
}

/** The fast runs, as read: none included in the plan, or how many are left of the limit. */
type FastRuns =
  | { included: false }
  | { included: true; limit: number; remaining: number; resetsAt: string | null };

/**
 * What the strip's card adds to the site's, shared with its skeleton: at each
 * width, the height of the strip with its four cells — 186 px below `lg`,
 * 124 px from `lg` on — so the page does not move when it arrives. A state
 * line, when there is one, still pushes what follows down.
 */
const FRAME = "mb-6 min-h-[186px] lg:min-h-[124px]";

const VALUE_TONES: Record<Tone, string> = {
  neutral: "text-gray-900 dark:text-gray-100",
  amber: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
};

const LINE_TONES: Record<Exclude<Tone, "neutral">, string> = {
  amber: "text-amber-800 dark:text-amber-300 bg-amber-50/60 dark:bg-amber-950/30",
  red: "text-red-700 dark:text-red-400 bg-red-50/60 dark:bg-red-950/30",
};

type BarTone = "sky" | "amber" | "red";

const BAR_TONES: Record<BarTone, string> = {
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

/** The bar is blue under the threshold, amber close to the limit, red once it is reached. */
const BAR_LEVEL_TONES: Record<ComputeLevel, BarTone> = {
  under: "sky",
  close: "amber",
  reached: "red",
};

/** Large screens: one column per cell, written out so the stylesheet keeps them. */
const LARGE_COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

/** Whole minutes, rounded down — `<1` for a time under a minute that is not nothing. */
function minutes(seconds: number): string {
  if (seconds > 0 && seconds < 60) return "<1";
  return String(Math.floor(seconds / 60));
}

/** The time left until `iso`, counted from now: `2 h 14 min`, `48 min`, `<1 min`. */
function timeLeft(iso: string): string {
  const total = Math.floor((Date.parse(iso) - Date.now()) / 60_000);
  if (total < 1) return "<1 min";
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * An instant as the browser's hour — hours and minutes, in its zone and its
 * locale, as the rest of the dashboard writes a time —, the hour in UTC as its
 * title (`HH:MM UTC`).
 */
function LocalTime({ iso }: { iso: string }) {
  const at = new Date(iso);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  const local = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <time dateTime={iso} title={`${hh}:${mm} UTC`}>
      {local}
    </time>
  );
}

// --- Reading the answer: each value checked, never taken on trust ---

/** A count the strip can show: a finite number. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The fields of an object; `null` for anything else — `null` itself is an object to `typeof`. */
function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" ? (value as Record<string, unknown> | null) : null;
}

/** An instant the strip can show: a text that reads as a date. */
function instantOf(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** The runs in progress — `null` without their bound, or without a count and a limit to show. */
function seatsOf(value: unknown): Seats | null {
  const seats = fieldsOf(value);
  if (!seats || !isCount(seats.in_use) || !isCount(seats.limit)) return null;
  return { inUse: seats.in_use, limit: seats.limit };
}

/** The compute — `null` without its bound, or without its use, its limit and its window's end. */
function computeOf(value: unknown): Compute | null {
  const compute = fieldsOf(value);
  const windowEnd = instantOf(fieldsOf(compute?.window)?.end);
  if (!compute || !isCount(compute.used_seconds) || !isCount(compute.limit_seconds)) return null;
  if (windowEnd === null) return null;
  return { used: compute.used_seconds, limit: compute.limit_seconds, windowEnd };
}

/**
 * The fast runs — `null` without a pool (`fast_runs: null`), with their bound
 * off (`limit: null`), or without a limit to show and, when the plan includes
 * some, what is left of it.
 */
function fastRunsOf(value: unknown): FastRuns | null {
  const fast = fieldsOf(value);
  if (!fast || !isCount(fast.limit)) return null;
  if (fast.limit === 0) return { included: false };
  if (!isCount(fast.remaining)) return null;
  return {
    included: true,
    limit: fast.limit,
    remaining: fast.remaining,
    resetsAt: instantOf(fast.resets_at),
  };
}

/** What the strip reads of the answer — whatever its shape. */
function readUsage(body: unknown) {
  const usage = fieldsOf(body);
  const quotas = fieldsOf(usage?.quotas);
  const plan = usage?.plan;
  return {
    plan: typeof plan === "string" && plan !== "" ? plan : null,
    seats: seatsOf(quotas?.concurrent_runs),
    compute: computeOf(quotas?.compute),
    fast: fastRunsOf(quotas?.fast_runs),
  };
}

type ComputeLevel = "under" | "close" | "reached";

/** Where the compute of the window stands: reached at 100 %, close from 80 % — in whole numbers. */
function computeLevel(compute: Compute): ComputeLevel {
  if (compute.used >= compute.limit) return "reached";
  if (compute.used * 5 >= compute.limit * 4) return "close";
  return "under";
}

/** The one state line, the gravest first: reached, every seat taken, close, fast starts used up. */
function statusOf(
  seats: Seats | null,
  compute: Compute | null,
  fast: FastRuns | null,
): { tone: Exclude<Tone, "neutral">; icon: ReactNode; text: ReactNode } | null {
  const icon = <IconError aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />;
  const level = compute ? computeLevel(compute) : "under";
  if (compute && level === "reached") {
    return {
      tone: "red",
      icon,
      text: (
        <>
          Limit reached — new runs start again at <LocalTime iso={compute.windowEnd} /> (in{" "}
          {timeLeft(compute.windowEnd)}).
        </>
      ),
    };
  }
  if (seats && seats.inUse >= seats.limit) {
    return {
      tone: "amber",
      icon,
      text: <>All {seats.limit} slots in use — a new run is refused until one finishes.</>,
    };
  }
  if (compute && level === "close") {
    return {
      tone: "amber",
      icon,
      text: (
        <>
          Close to your limit — the window resets at <LocalTime iso={compute.windowEnd} />.
        </>
      ),
    };
  }
  if (fast?.included && fast.remaining === 0) {
    return {
      tone: "amber",
      icon: <IconClock aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />,
      text: fast.resetsAt ? (
        <>
          Fast starts used up — runs still start, about a minute slower, until{" "}
          <LocalTime iso={fast.resetsAt} />.
        </>
      ) : (
        <>Fast starts used up — runs still start, about a minute slower.</>
      ),
    };
  }
  return null;
}

/**
 * A cell: its label and value side by side below `md`, stacked from `md` on;
 * what goes `below` the value takes a line of its own across the cell.
 */
function Cell({
  label,
  children,
  below,
}: {
  label: string;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="min-w-0 flex flex-wrap items-baseline justify-between gap-x-3 md:block">
      <dt className="text-[11.5px] text-gray-500 dark:text-gray-500">{label}</dt>
      <dd className="md:mt-1 text-[13px] tabular-nums text-right md:text-left">{children}</dd>
      {below !== undefined && <dd className="basis-full">{below}</dd>}
    </div>
  );
}

function Value({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span data-tone={tone} className={`font-semibold ${VALUE_TONES[tone]}`}>
      {children}
    </span>
  );
}

function ComputeBar({ compute }: { compute: Compute }) {
  const { used, limit } = compute;
  const usedMinutes = Math.floor(used / 60);
  const limitMinutes = Math.floor(limit / 60);
  const words = used > 0 && used < 60 ? "less than 1" : String(usedMinutes);
  const tone = BAR_LEVEL_TONES[computeLevel(compute)];
  const width = Math.min(100, (used / limit) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={limitMinutes}
      aria-valuenow={Math.min(usedMinutes, limitMinutes)}
      aria-valuetext={`${words} of ${limitMinutes} minutes used this window`}
      data-tone={tone}
      className="mt-1.5 h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-900 overflow-hidden"
    >
      <div className={`h-full rounded-full ${BAR_TONES[tone]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function Skeleton() {
  return (
    <Card className={FRAME} pad={false}>
      <div data-testid="usage-strip-skeleton" aria-busy="true">
        <div className="flex items-center px-4 h-10 border-b border-gray-100 dark:border-gray-900">
          <div className="h-3 w-12 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse" />
        </div>
        <div className="px-4 py-3">
          <div className="h-9 bg-gray-100 dark:bg-gray-800 rounded-sm animate-pulse" />
        </div>
      </div>
    </Card>
  );
}

/** Any error while the strip renders leaves the strip out — never the page around it. */
class StripBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function UsageStrip() {
  return (
    <StripBoundary>
      <UsageStripContent />
    </StripBoundary>
  );
}

function UsageStripContent() {
  const { data, isLoading, error, errorUpdateCount } = useUsage();
  const titleId = useId();

  // The skeleton holds the place for the first read only: read again after a
  // failure, the strip stays away until an answer comes.
  if (isLoading && errorUpdateCount === 0) return <Skeleton />;
  // Any answer but a 200 — a refused key, a server without the route, an
  // error — shows nothing, even after an earlier read did.
  if (error) return null;

  const { plan, seats, compute, fast } = readUsage(data);

  const cells: ReactNode[] = [];
  if (seats) {
    cells.push(
      <Cell key="seats" label="Runs in progress">
        <Value tone={seats.inUse >= seats.limit ? "amber" : "neutral"}>
          {seats.inUse} of {seats.limit}
        </Value>
      </Cell>,
    );
  }
  if (compute) {
    cells.push(
      <Cell key="compute" label="Compute this window" below={<ComputeBar compute={compute} />}>
        <Value tone="neutral">
          {minutes(compute.used)} of {minutes(compute.limit)} min
        </Value>
      </Cell>,
    );
  }
  if (fast) {
    cells.push(
      <Cell key="fast" label="Fast starts this hour">
        {fast.included ? (
          <Value tone={fast.remaining === 0 ? "amber" : "neutral"}>
            {fast.remaining} of {fast.limit} left
          </Value>
        ) : (
          <Value tone="neutral">Not included in your plan</Value>
        )}
      </Cell>,
    );
  }
  if (compute) {
    cells.push(
      <Cell key="resets" label="Resets">
        <Value tone="neutral">
          <LocalTime iso={compute.windowEnd} />
        </Value>{" "}
        <span className="text-[11px] text-gray-500 dark:text-gray-500 md:block">
          in {timeLeft(compute.windowEnd)}
        </span>
      </Cell>,
    );
  }
  // Nothing the strip shows — no quota at all, or only bounds it does not show.
  if (cells.length === 0) return null;

  const reached = compute !== null && computeLevel(compute) === "reached";
  const status = statusOf(seats, compute, fast);

  return (
    <Card
      title="Usage"
      titleId={titleId}
      action={
        <div className="flex items-center gap-1.5">
          {reached && (
            <Pill tone="red" dot>
              Limit reached
            </Pill>
          )}
          {plan !== null && <Pill tone="neutral">{plan}</Pill>}
        </div>
      }
      className={FRAME}
      pad={false}
    >
      <dl
        className={`grid grid-cols-1 md:grid-cols-2 ${LARGE_COLUMNS[cells.length]} gap-x-6 gap-y-2.5 px-4 py-3`}
      >
        {cells}
      </dl>
      {status && (
        <p
          data-testid="usage-strip-status"
          data-tone={status.tone}
          className={`flex items-center gap-1.5 px-4 py-2 border-t border-gray-100 dark:border-gray-900 rounded-b-lg text-[12px] ${LINE_TONES[status.tone]}`}
        >
          {status.icon}
          <span>{status.text}</span>
        </p>
      )}
    </Card>
  );
}
