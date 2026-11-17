import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastRunsUsage, UsageResponse } from "../../lib/api-client";
import { renderWithProviders } from "../../test-utils";
import { UsageStrip } from "./usage-strip";

// Every case renders at this instant: the remaining times are counted from it,
// never from the machine's clock, and every hour is in UTC by the data — shown in the
// machine's zone, expected by the same call as the strip's.
const NOW = "2026-10-20T09:45:30.000Z";
// The window ends 2 h 14 min 30 s after NOW.
const WINDOW = { start: "2026-10-20T06:00:00.000Z", end: "2026-10-20T12:00:00.000Z" };

type Quotas = NonNullable<UsageResponse["quotas"]>;

const SEATS: Quotas["concurrent_runs"] = { limit: 2, in_use: 1 };
/** 12 of 60 min — under the threshold. */
const COMPUTE: Quotas["compute"] = { limit_seconds: 3600, used_seconds: 720, window: WINDOW };
const FAST: FastRunsUsage = { limit: 20, remaining: 14, resets_at: "2026-10-20T10:20:00.000Z" };

function usage(quotas: Partial<Quotas> | null, plan = "free"): UsageResponse {
  return {
    plan,
    quotas:
      quotas === null
        ? null
        : { concurrent_runs: SEATS, compute: COMPUTE, fast_runs: FAST, ...quotas },
  };
}

let asked = 0;
let answer: () => Response = () => HttpResponse.json(usage({}));
const server = setupServer(
  http.get("/api/usage", () => {
    asked += 1;
    return answer();
  }),
  http.get("/api/me", () =>
    HttpResponse.json({ id: "u1", username: "dev", namespace: "dev", role: "user" }),
  ),
);

beforeAll(() => server.listen());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
  asked = 0;
  answer = () => HttpResponse.json(usage({}));
});
afterAll(() => server.close());

/** The hour the strip writes: the same reading of the instant, in the machine's zone and locale. */
function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Renders the strip on `body` — any JSON, whatever its shape — and waits for its region. */
async function renderStrip(body: UsageResponse | Record<string, unknown>) {
  answer = () => HttpResponse.json(body);
  const rendered = renderWithProviders(<UsageStrip />);
  const region = await screen.findByRole("region", { name: "Usage" });
  return { ...rendered, region };
}

/** Renders the strip on `respond` and waits until the answer was read and nothing is loading. */
async function renderSettled(respond: () => Response) {
  answer = respond;
  const rendered = renderWithProviders(<UsageStrip />);
  await waitFor(() => {
    expect(asked).toBe(1);
    expect(screen.queryByTestId("usage-strip-skeleton")).toBeNull();
  });
  return rendered;
}

/** The value of the cell labelled `label`. */
function cell(region: HTMLElement, label: string): HTMLElement {
  const term = within(region).getByText(label, { selector: "dt" });
  const value = term.parentElement?.querySelector("dd");
  if (!value) throw new Error(`no value for ${label}`);
  return value;
}

function labels(region: HTMLElement): string[] {
  return Array.from(region.querySelectorAll("dt")).map((dt) => dt.textContent ?? "");
}

function statusLines(region: HTMLElement): string[] {
  return within(region)
    .queryAllByTestId("usage-strip-status")
    .map((line) => line.textContent ?? "");
}

describe("UsageStrip — when it is there at all", () => {
  it("while the usage loads, a skeleton in the strip's own frame: the same height classes, at each width", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/usage", async () => {
        await held;
        return HttpResponse.json(usage({}));
      }),
    );
    const { container } = renderWithProviders(<UsageStrip />);

    const skeleton = await screen.findByTestId("usage-strip-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.textContent).toBe("");
    expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
    // The frame the skeleton sits in: the strip's card.
    const loading = container.firstElementChild;
    expect(loading?.contains(skeleton)).toBe(true);
    const frame = loading?.className ?? "";
    // The heights the strip measures with its four cells: below `lg`, then from `lg` on.
    expect(frame.split(" ")).toEqual(expect.arrayContaining(["min-h-[186px]", "lg:min-h-[124px]"]));

    release();
    const region = await screen.findByRole("region", { name: "Usage" });
    expect(screen.queryByTestId("usage-strip-skeleton")).toBeNull();
    expect(region).toBe(container.firstElementChild);
    expect(region.className).toBe(frame);
  });

  it("a server that sets no quota (quotas: null): no strip", async () => {
    const { container } = await renderSettled(() => HttpResponse.json(usage(null)));
    expect(container).toBeEmptyDOMElement();
  });

  it("quotas set, but none it shows — no seats, no compute, no fast runs: no strip", async () => {
    const { container } = await renderSettled(() =>
      HttpResponse.json(usage({ concurrent_runs: null, compute: null, fast_runs: null })),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("quotas set, but none it shows — a pool runs with its fast-run bound off: no strip", async () => {
    const { container } = await renderSettled(() =>
      HttpResponse.json(
        usage({
          concurrent_runs: null,
          compute: null,
          fast_runs: { limit: null, remaining: null, resets_at: null },
        }),
      ),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [403, "KEY_SCOPE_FORBIDDEN"],
    [404, "NOT_FOUND"],
    [500, "INTERNAL_ERROR"],
  ])("a %i answer: no strip, nothing made up", async (status, code) => {
    const { container } = await renderSettled(() =>
      HttpResponse.json({ error: { code, message: "no" } }, { status }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("a request that fails before any answer — a network error: no strip", async () => {
    const { container } = await renderSettled(() => HttpResponse.error());
    expect(container).toBeEmptyDOMElement();
  });

  it("a strip already shown goes away when its next read is refused", async () => {
    const { queryClient, region } = await renderStrip(usage({}));
    expect(region).toBeInTheDocument();

    answer = () =>
      HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "no" } }, { status: 500 });
    await queryClient.invalidateQueries({ queryKey: ["usage"] });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Usage" })).toBeNull());
  });

  it("read again after a first read that failed: no skeleton meanwhile, the strip once it answers", async () => {
    const { queryClient, container } = await renderSettled(() =>
      HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "no" } }, { status: 500 }),
    );
    expect(container).toBeEmptyDOMElement();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/usage", async () => {
        asked += 1;
        await held;
        return HttpResponse.json(usage({}));
      }),
    );
    const readAgain = queryClient.refetchQueries({ queryKey: ["usage"] });
    await waitFor(() => expect(asked).toBe(2));
    // Time for a render while the read is under way.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryClient.getQueryState(["usage"])?.fetchStatus).toBe("fetching");
    expect(screen.queryByTestId("usage-strip-skeleton")).toBeNull();
    expect(container).toBeEmptyDOMElement();

    release();
    await readAgain;
    expect(await screen.findByRole("region", { name: "Usage" })).toBeInTheDocument();
  });

  it("only the fast-run cell, a plan that includes none: the strip is there, with that cell alone", async () => {
    const { region } = await renderStrip(
      usage({
        concurrent_runs: null,
        compute: null,
        fast_runs: { limit: 0, remaining: 0, resets_at: null },
      }),
    );
    expect(labels(region)).toEqual(["Fast starts this hour"]);
    expect(cell(region, "Fast starts this hour").textContent).toBe("Not included in your plan");
  });
});

describe("UsageStrip — its cells", () => {
  it("with a pool: the plan, the runs in progress, the compute, the fast starts and the reset, in one row of four", async () => {
    const { region } = await renderStrip(usage({}));

    expect(within(region).getByRole("heading", { level: 3, name: "Usage" })).toBeInTheDocument();
    expect(within(region).getByText("free")).toBeInTheDocument();
    expect(labels(region)).toEqual([
      "Runs in progress",
      "Compute this window",
      "Fast starts this hour",
      "Resets",
    ]);
    expect(cell(region, "Runs in progress").textContent).toBe("1 of 2");
    expect(cell(region, "Compute this window").textContent).toBe("12 of 60 min");
    expect(cell(region, "Fast starts this hour").textContent).toBe("14 of 20 left");
    expect(region.querySelector("dl")?.className).toContain("lg:grid-cols-4");
    expect(statusLines(region)).toEqual([]);
  });

  it("no pool (fast_runs: null): no fast-start cell and nothing said of it, the three others in three columns", async () => {
    const { region } = await renderStrip(usage({ fast_runs: null }));

    expect(labels(region)).toEqual(["Runs in progress", "Compute this window", "Resets"]);
    expect(within(region).queryByText(/fast start/i)).toBeNull();
    expect(within(region).queryByText("Not included in your plan")).toBeNull();
    expect(region.querySelector("dl")?.className).toContain("lg:grid-cols-3");
    expect(cell(region, "Runs in progress").textContent).toBe("1 of 2");
  });

  it("a pool with its fast-run bound off (limit: null): no fast-start cell, the rest unchanged", async () => {
    const { region } = await renderStrip(
      usage({ fast_runs: { limit: null, remaining: null, resets_at: null } }),
    );

    expect(labels(region)).toEqual(["Runs in progress", "Compute this window", "Resets"]);
    expect(within(region).queryByText(/fast start/i)).toBeNull();
  });

  it("a plan that includes no fast run (limit: 0): « Not included in your plan », with no alert tint and no message", async () => {
    const { region } = await renderStrip(
      usage({ fast_runs: { limit: 0, remaining: 0, resets_at: null } }),
    );

    const value = cell(region, "Fast starts this hour");
    expect(value.textContent).toBe("Not included in your plan");
    expect(value.querySelector("[data-tone]")).toHaveAttribute("data-tone", "neutral");
    expect(statusLines(region)).toEqual([]);
  });

  it("no seat bound: no runs-in-progress cell; no compute bound: neither the compute nor the reset", async () => {
    const { region } = await renderStrip(usage({ concurrent_runs: null, compute: null }));

    expect(labels(region)).toEqual(["Fast starts this hour"]);
    expect(region.querySelector("[role=progressbar]")).toBeNull();
  });

  it("no compute bound alone: the reset goes with it", async () => {
    const { region } = await renderStrip(usage({ compute: null }));

    expect(labels(region)).toEqual(["Runs in progress", "Fast starts this hour"]);
    expect(region.querySelector("dl")?.className).toContain("lg:grid-cols-2");
  });

  it("the plan as the server names it — a plan named otherwise is shown as it is", async () => {
    const { region } = await renderStrip(usage({}, "team"));

    expect(within(region).getByText("team")).toBeInTheDocument();
    expect(within(region).queryByText("free")).toBeNull();
  });

  it("the compute bar: a progressbar from 0 to the limit in minutes, its value and its words", async () => {
    const { region } = await renderStrip(usage({}));

    const bar = within(region).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "60");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuetext", "12 of 60 minutes used this window");
    expect(bar).toHaveAttribute("data-tone", "sky");
  });

  it("the compute bar on a line of its own, across its cell — below md, not beside the value", async () => {
    const { region } = await renderStrip(usage({}));

    const own = within(region).getByRole("progressbar").parentElement;
    expect(own?.tagName).toBe("DD");
    expect(own?.className.split(" ")).toContain("basis-full");
    expect(own?.parentElement?.className.split(" ")).toContain("flex-wrap");
    expect(cell(region, "Compute this window").textContent).toBe("12 of 60 min");
    // The other cells have nothing below their value.
    for (const label of ["Runs in progress", "Fast starts this hour", "Resets"]) {
      expect(cell(region, label).parentElement?.querySelectorAll("dd")).toHaveLength(1);
    }
  });

  it("minutes are rounded down: 719 s of 3599 s are 11 of 59 min", async () => {
    const { region } = await renderStrip(
      usage({ compute: { limit_seconds: 3599, used_seconds: 719, window: WINDOW } }),
    );

    expect(cell(region, "Compute this window").textContent).toBe("11 of 59 min");
    const bar = within(region).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "11");
    expect(bar).toHaveAttribute("aria-valuemax", "59");
  });

  it("under a minute used: « <1 », the bar's words say less than one", async () => {
    const { region } = await renderStrip(
      usage({ compute: { limit_seconds: 3600, used_seconds: 30, window: WINDOW } }),
    );

    expect(cell(region, "Compute this window").textContent).toBe("<1 of 60 min");
    const bar = within(region).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuetext", "less than 1 of 60 minutes used this window");
  });

  it("nothing used: 0, not « <1 »", async () => {
    const { region } = await renderStrip(
      usage({ compute: { limit_seconds: 3600, used_seconds: 0, window: WINDOW } }),
    );

    expect(cell(region, "Compute this window").textContent).toBe("0 of 60 min");
  });

  it("the reset: the window's end in the browser's hour in a <time>, the hour in UTC as its title, and the time left counted down", async () => {
    const { region } = await renderStrip(usage({}));

    const value = cell(region, "Resets");
    const time = value.querySelector("time");
    expect(time).toHaveAttribute("datetime", WINDOW.end);
    expect(time?.textContent).toBe(localTime(WINDOW.end));
    expect(time).toHaveAttribute("title", "12:00 UTC");
    // 2 h 14 min 30 s left: rounded down.
    expect(value.textContent).toBe(`${localTime(WINDOW.end)} in 2 h 14 min`);
  });

  it("the time left under a minute: « <1 min »", async () => {
    vi.setSystemTime(new Date("2026-10-20T11:59:15.000Z"));
    const { region } = await renderStrip(usage({}));

    expect(cell(region, "Resets").textContent).toBe(`${localTime(WINDOW.end)} in <1 min`);
  });

  it("the time left under an hour: minutes alone", async () => {
    vi.setSystemTime(new Date("2026-10-20T11:12:00.000Z"));
    const { region } = await renderStrip(usage({}));

    expect(cell(region, "Resets").textContent).toBe(`${localTime(WINDOW.end)} in 48 min`);
  });

  it("the time left on a round hour: « 2 h », no minutes", async () => {
    vi.setSystemTime(new Date("2026-10-20T10:00:00.000Z"));
    const { region } = await renderStrip(usage({}));

    expect(cell(region, "Resets").textContent).toBe(`${localTime(WINDOW.end)} in 2 h`);
  });

  /** Runs `body` with the machine's zone set to `tz`, then gives back the zone the case found. */
  async function inZone(tz: string, body: () => Promise<void>) {
    const zone = process.env.TZ;
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = tz;
    try {
      await body();
    } finally {
      // Deleting the variable alone would keep this zone.
      process.env.TZ = zone ?? machine;
      if (zone === undefined) Reflect.deleteProperty(process.env, "TZ");
    }
  }

  it("on a machine half an hour off UTC: the hours in its zone, the hour in UTC as their title", async () => {
    await inZone("Asia/Kolkata", async () => {
      // The zone is in force for this case, for the date and for its formatting: 12:00 UTC is 17:30 there.
      expect(new Date(WINDOW.end).getHours()).toBe(17);
      // ICU may name it by its older name.
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toMatch(
        /^Asia\/(Kolkata|Calcutta)$/,
      );
      expect(localTime(WINDOW.end)).toMatch(/30/);
      const { region } = await renderStrip(
        usage({ compute: { limit_seconds: 3600, used_seconds: 3600, window: WINDOW } }),
      );

      const time = cell(region, "Resets").querySelector("time");
      expect(time?.textContent).toBe(localTime(WINDOW.end));
      expect(time).toHaveAttribute("title", "12:00 UTC");
      expect(statusLines(region)).toEqual([
        `Limit reached — new runs start again at ${localTime(WINDOW.end)} (in 2 h 14 min).`,
      ]);
      const lineTime = within(region).getByTestId("usage-strip-status").querySelector("time");
      expect(lineTime).toHaveAttribute("title", "12:00 UTC");
    });
  });

  it("on a machine in UTC: the hour in its locale, never « UTC » in the text, the hour in UTC as its title", async () => {
    await inZone("UTC", async () => {
      // The zone is in force for this case.
      expect(new Date(WINDOW.end).getHours()).toBe(12);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toMatch(/^(Etc\/)?UTC$/);
      const { region } = await renderStrip(
        usage({ compute: { limit_seconds: 3600, used_seconds: 3600, window: WINDOW } }),
      );

      const time = cell(region, "Resets").querySelector("time");
      expect(time?.textContent).toBe(localTime(WINDOW.end));
      expect(time?.textContent).not.toContain("UTC");
      expect(time).toHaveAttribute("title", "12:00 UTC");
      expect(statusLines(region)).toEqual([
        `Limit reached — new runs start again at ${localTime(WINDOW.end)} (in 2 h 14 min).`,
      ]);
    });
  });
});

describe("UsageStrip — its states", () => {
  /** A compute of `used` seconds of 3600. */
  const computeAt = (used: number): Quotas["compute"] => ({
    limit_seconds: 3600,
    used_seconds: used,
    window: WINDOW,
  });

  it("under the threshold: neutral tints, a blue bar, no message", async () => {
    const { region } = await renderStrip(usage({ compute: computeAt(2879) }));

    expect(within(region).getByRole("progressbar")).toHaveAttribute("data-tone", "sky");
    expect(cell(region, "Runs in progress").querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(cell(region, "Fast starts this hour").querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(within(region).queryByText("Limit reached")).toBeNull();
    expect(statusLines(region)).toEqual([]);
  });

  it("close — 80 % of the compute: an amber bar and « Close to your limit »", async () => {
    const { region } = await renderStrip(usage({ compute: computeAt(2880) }));

    expect(within(region).getByRole("progressbar")).toHaveAttribute("data-tone", "amber");
    expect(statusLines(region)).toEqual([
      `Close to your limit — the window resets at ${localTime(WINDOW.end)}.`,
    ]);
    const time = within(region).getByTestId("usage-strip-status").querySelector("time");
    expect(time).toHaveAttribute("datetime", WINDOW.end);
    expect(time).toHaveAttribute("title", "12:00 UTC");
    expect(within(region).queryByText("Limit reached")).toBeNull();
  });

  it("just under 100 %: still close, not reached", async () => {
    const { region } = await renderStrip(usage({ compute: computeAt(3599) }));

    expect(statusLines(region)).toEqual([
      `Close to your limit — the window resets at ${localTime(WINDOW.end)}.`,
    ]);
    expect(within(region).queryByText("Limit reached")).toBeNull();
  });

  it("reached — 100 % of the compute: a red « Limit reached » pill and when runs start again", async () => {
    const { region } = await renderStrip(usage({ compute: computeAt(3600) }));

    expect(within(region).getByText("Limit reached")).toBeInTheDocument();
    expect(within(region).getByRole("progressbar")).toHaveAttribute("data-tone", "red");
    expect(statusLines(region)).toEqual([
      `Limit reached — new runs start again at ${localTime(WINDOW.end)} (in 2 h 14 min).`,
    ]);
    expect(within(region).getByTestId("usage-strip-status")).toHaveAttribute("data-tone", "red");
  });

  it.each([
    ["under the threshold", 2879, "sky", "bg-sky-500"],
    ["close", 2880, "amber", "bg-amber-500"],
    ["reached", 3600, "red", "bg-red-500"],
  ])("the bar's fill in the tint of its state — %s", async (_case, used, tone, fill) => {
    const { region } = await renderStrip(usage({ compute: computeAt(used) }));

    const bar = within(region).getByRole("progressbar");
    expect(bar).toHaveAttribute("data-tone", tone);
    expect(bar.firstElementChild?.className.split(" ")).toContain(fill);
  });

  it("past the limit: reached, the bar full and its value no higher than its maximum", async () => {
    const { region } = await renderStrip(usage({ compute: computeAt(3900) }));

    const bar = within(region).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "60");
    expect(bar).toHaveAttribute("aria-valuetext", "65 of 60 minutes used this window");
    expect(cell(region, "Compute this window").textContent).toBe("65 of 60 min");
    expect(within(region).getByText("Limit reached")).toBeInTheDocument();
  });

  it("every seat taken: the value in amber and « All 2 slots in use »", async () => {
    const { region } = await renderStrip(usage({ concurrent_runs: { limit: 2, in_use: 2 } }));

    expect(cell(region, "Runs in progress").querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "amber",
    );
    expect(statusLines(region)).toEqual([
      "All 2 slots in use — a new run is refused until one finishes.",
    ]);
  });

  it("more runs in progress than the limit — a plan lowered: the value in amber and « All 2 slots in use »", async () => {
    const { region } = await renderStrip(usage({ concurrent_runs: { limit: 2, in_use: 3 } }));

    expect(cell(region, "Runs in progress").textContent).toBe("3 of 2");
    expect(cell(region, "Runs in progress").querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "amber",
    );
    expect(statusLines(region)).toEqual([
      "All 2 slots in use — a new run is refused until one finishes.",
    ]);
  });

  it("one seat free: neutral, no message", async () => {
    const { region } = await renderStrip(usage({ concurrent_runs: { limit: 5, in_use: 4 } }));

    expect(cell(region, "Runs in progress").querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(statusLines(region)).toEqual([]);
  });

  it("fast starts used up: the value in amber and until when, the hour the route gives", async () => {
    const { region } = await renderStrip(
      usage({ fast_runs: { limit: 2, remaining: 0, resets_at: "2026-10-20T10:20:00.000Z" } }),
    );

    expect(cell(region, "Fast starts this hour").textContent).toBe("0 of 2 left");
    expect(cell(region, "Fast starts this hour").querySelector("[data-tone]")).toHaveAttribute(
      "data-tone",
      "amber",
    );
    expect(statusLines(region)).toEqual([
      `Fast starts used up — runs still start, about a minute slower, until ${localTime("2026-10-20T10:20:00.000Z")}.`,
    ]);
    const time = within(region).getByTestId("usage-strip-status").querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-10-20T10:20:00.000Z");
    expect(time).toHaveAttribute("title", "10:20 UTC");
  });

  it("fast starts used up with no return given (resets_at: null): the line without its hour", async () => {
    const { region } = await renderStrip(
      usage({ fast_runs: { limit: 2, remaining: 0, resets_at: null } }),
    );

    expect(statusLines(region)).toEqual([
      "Fast starts used up — runs still start, about a minute slower.",
    ]);
    expect(within(region).getByTestId("usage-strip-status").querySelector("time")).toBeNull();
  });

  it("one message at a time, the gravest: reached over every seat taken, close and fast starts used up", async () => {
    const { region } = await renderStrip(
      usage({
        concurrent_runs: { limit: 2, in_use: 2 },
        compute: computeAt(3600),
        fast_runs: { limit: 2, remaining: 0, resets_at: "2026-10-20T10:20:00.000Z" },
      }),
    );

    expect(statusLines(region)).toEqual([
      `Limit reached — new runs start again at ${localTime(WINDOW.end)} (in 2 h 14 min).`,
    ]);
  });

  it("one message at a time: every seat taken over close and fast starts used up", async () => {
    const { region } = await renderStrip(
      usage({
        concurrent_runs: { limit: 2, in_use: 2 },
        compute: computeAt(3000),
        fast_runs: { limit: 2, remaining: 0, resets_at: "2026-10-20T10:20:00.000Z" },
      }),
    );

    expect(statusLines(region)).toEqual([
      "All 2 slots in use — a new run is refused until one finishes.",
    ]);
  });

  it("one message at a time: close over fast starts used up", async () => {
    const { region } = await renderStrip(
      usage({
        compute: computeAt(3000),
        fast_runs: { limit: 2, remaining: 0, resets_at: "2026-10-20T10:20:00.000Z" },
      }),
    );

    expect(statusLines(region)).toEqual([
      `Close to your limit — the window resets at ${localTime(WINDOW.end)}.`,
    ]);
  });

  it.each([
    ["the limit reached", { compute: computeAt(3600) }],
    [
      "fast starts used up",
      { fast_runs: { limit: 2, remaining: 0, resets_at: "2026-10-20T10:20:00.000Z" } },
    ],
  ])("its icons are decorative — %s", async (_case, quotas) => {
    const { region } = await renderStrip(usage(quotas));

    const icons = Array.from(region.querySelectorAll("svg"));
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("its numbers in tabular figures", async () => {
    const { region } = await renderStrip(usage({}));

    for (const label of [
      "Runs in progress",
      "Compute this window",
      "Fast starts this hour",
      "Resets",
    ]) {
      expect(cell(region, label).className).toContain("tabular-nums");
    }
  });
});

describe("UsageStrip — an answer it cannot read", () => {
  /** A 200 whose quotas are those of `usage({})` with `quotas` written over them — any shape. */
  function answered(
    quotas: Record<string, unknown>,
    plan: Record<string, unknown> = { plan: "free" },
  ) {
    return {
      ...plan,
      quotas: { concurrent_runs: SEATS, compute: COMPUTE, fast_runs: FAST, ...quotas },
    };
  }

  /** The pills beside the title, by their text. */
  function pills(region: HTMLElement): string[] {
    const beside = region.querySelector("h3")?.nextElementSibling;
    return Array.from(beside?.children ?? []).map((pill) => pill.textContent ?? "");
  }

  it.each([
    [
      "the runs in progress without their count (in_use renamed)",
      { concurrent_runs: { limit: 2, running: 1 } },
      ["Compute this window", "Fast starts this hour", "Resets"],
    ],
    [
      "the runs in progress with a number as text",
      { concurrent_runs: { limit: "2", in_use: 1 } },
      ["Compute this window", "Fast starts this hour", "Resets"],
    ],
    [
      "the compute without its window (window renamed): the reset goes with it",
      { compute: { limit_seconds: 3600, used_seconds: 720, period: WINDOW } },
      ["Runs in progress", "Fast starts this hour"],
    ],
    [
      "the compute whose window ends on no instant",
      { compute: { limit_seconds: 3600, used_seconds: 720, window: { ...WINDOW, end: "soon" } } },
      ["Runs in progress", "Fast starts this hour"],
    ],
    [
      "the compute without its use (used_seconds renamed)",
      { compute: { limit_seconds: 3600, used: 720, window: WINDOW } },
      ["Runs in progress", "Fast starts this hour"],
    ],
    [
      "the compute with its limit as text",
      { compute: { limit_seconds: "3600", used_seconds: 720, window: WINDOW } },
      ["Runs in progress", "Fast starts this hour"],
    ],
    [
      "the fast starts without what is left (remaining renamed)",
      { fast_runs: { limit: 20, left: 14, resets_at: FAST.resets_at } },
      ["Runs in progress", "Compute this window", "Resets"],
    ],
    [
      "the fast starts with their limit as text",
      { fast_runs: { limit: "20", remaining: 14, resets_at: FAST.resets_at } },
      ["Runs in progress", "Compute this window", "Resets"],
    ],
  ])("%s: that cell is left out, nothing shown as 0 or NaN", async (_case, quotas, shown) => {
    const { region } = await renderStrip(answered(quotas));

    expect(labels(region)).toEqual(shown);
    expect(region.textContent).not.toMatch(/NaN|undefined/);
    expect(statusLines(region)).toEqual([]);
  });

  it("a compute past its limit, its window renamed: neither « Limit reached » nor its line", async () => {
    const { region } = await renderStrip(
      answered({ compute: { limit_seconds: 3600, used_seconds: 3600, period: WINDOW } }),
    );

    expect(within(region).queryByText("Limit reached")).toBeNull();
    expect(within(region).queryByRole("progressbar")).toBeNull();
    expect(statusLines(region)).toEqual([]);
  });

  it("every seat taken, its limit as text: no « All slots in use » line", async () => {
    const { region } = await renderStrip(answered({ concurrent_runs: { limit: "2", in_use: 2 } }));

    expect(statusLines(region)).toEqual([]);
  });

  it("fast starts with remaining renamed: never « 0 left », no « used up » line", async () => {
    const { region } = await renderStrip(
      answered({ fast_runs: { limit: 2, left: 0, resets_at: FAST.resets_at } }),
    );

    expect(within(region).queryByText(/fast start/i)).toBeNull();
    expect(statusLines(region)).toEqual([]);
  });

  it("a plan that includes no fast start (limit: 0) needs nothing more: « Not included in your plan »", async () => {
    const { region } = await renderStrip(answered({ fast_runs: { limit: 0 } }));

    expect(cell(region, "Fast starts this hour").textContent).toBe("Not included in your plan");
  });

  it("fast starts used up with a return that is no instant: the line without its hour", async () => {
    const { region } = await renderStrip(
      answered({ fast_runs: { limit: 2, remaining: 0, resets_at: 1760955600 } }),
    );

    expect(statusLines(region)).toEqual([
      "Fast starts used up — runs still start, about a minute slower.",
    ]);
  });

  it("a plan read: its pill beside the title, alone", async () => {
    const { region } = await renderStrip(answered({}));

    expect(pills(region)).toEqual(["free"]);
  });

  it.each([
    ["no plan", {}],
    ["an empty plan", { plan: "" }],
    ["a plan that is not a text", { plan: 42 }],
  ])("%s: the strip without its plan pill", async (_case, plan) => {
    const { region } = await renderStrip(answered({}, plan));

    expect(within(region).getByRole("heading", { level: 3 }).textContent).toBe("Usage");
    expect(pills(region)).toEqual([]);
    expect(labels(region)).toEqual([
      "Runs in progress",
      "Compute this window",
      "Fast starts this hour",
      "Resets",
    ]);
  });

  it("a count too large for a number: that cell is left out, never « Infinity »", async () => {
    answer = () =>
      new HttpResponse(
        `{"plan":"free","quotas":{"concurrent_runs":{"limit":1e400,"in_use":1},"compute":${JSON.stringify(COMPUTE)},"fast_runs":null}}`,
        { headers: { "Content-Type": "application/json" } },
      );
    renderWithProviders(<UsageStrip />);
    const region = await screen.findByRole("region", { name: "Usage" });

    expect(labels(region)).toEqual(["Compute this window", "Resets"]);
    expect(region.textContent).not.toMatch(/Infinity/);
  });

  it.each([
    ["quotas renamed", { plan: "free", limits: { concurrent_runs: SEATS } }],
    ["a body that is a list", [SEATS]],
    ["a body that is a text", "ok"],
  ])("%s: no cell to show, no strip", async (_case, body) => {
    const { container } = await renderSettled(() => HttpResponse.json(body));

    expect(container).toBeEmptyDOMElement();
  });
});
