import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type InstanceResponse,
  instanceLinks,
  USAGE_QUERY_KEY,
  USAGE_REREAD_MARGIN_MS,
  type UsageResponse,
  useInstance,
  useUsage,
} from "./api-client";

const USAGE: UsageResponse = {
  plan: "free",
  quotas: {
    concurrent_runs: { limit: 2, in_use: 1 },
    compute: {
      limit_seconds: 3600,
      used_seconds: 720,
      window: { start: "2026-10-20T06:00:00.000Z", end: "2026-10-20T12:00:00.000Z" },
    },
    fast_runs: null,
  },
};

const asked: Array<{ method: string; path: string }> = [];
const server = setupServer(
  http.get("/api/usage", ({ request }) => {
    asked.push({ method: request.method, path: new URL(request.url).pathname });
    return HttpResponse.json(USAGE);
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  asked.length = 0;
});
afterAll(() => server.close());

/** A client whose default freshness is `staleTime`, as the app's is 30 s. */
function clientWith(staleTime: number) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime } } });
}

function wrapperOf(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * A client with the app's own defaults — its `retry: 1` among them —, without
 * the wait between two tries, which decides nothing of whether it asks again.
 */
function appClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
        retryDelay: 0,
        gcTime: 0,
      },
    },
  });
}

/** Answers every read of the usage with `respond`, each read counted. */
function answering(respond: () => Response | Promise<Response>) {
  server.use(
    http.get("/api/usage", ({ request }) => {
      asked.push({ method: request.method, path: new URL(request.url).pathname });
      return respond();
    }),
  );
}

function refused(status: number, code: string) {
  return () => HttpResponse.json({ error: { code, message: "no" } }, { status });
}

describe("useUsage", () => {
  it("reads GET /api/usage and hands back its body as it is", async () => {
    const client = clientWith(30_000);
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(USAGE);
    expect(asked).toEqual([{ method: "GET", path: "/api/usage" }]);
  });

  it("is kept under the key a playground run invalidates", async () => {
    const client = clientWith(30_000);
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(USAGE_QUERY_KEY).toEqual(["usage"]);
    expect(client.getQueryData(["usage"])).toEqual(USAGE);
  });

  it("keeps the app's default freshness — no staleTime of its own", async () => {
    const client = clientWith(12_345);
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = client.getQueryCache().find({ queryKey: ["usage"] });
    expect((query?.options as { staleTime?: number } | undefined)?.staleTime).toBe(12_345);
  });

  it.each([
    [403, "KEY_SCOPE_FORBIDDEN"],
    [404, "NOT_FOUND"],
    [500, "INTERNAL_ERROR"],
  ])("a %i answer is an error that carries its status and code", async (status, code) => {
    server.use(
      http.get("/api/usage", () =>
        HttpResponse.json({ error: { code, message: "no" } }, { status }),
      ),
    );
    const client = clientWith(30_000);
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(status);
    expect((result.current.error as ApiError).code).toBe(code);
    expect(result.current.data).toBeUndefined();
  });
});

describe("useUsage — what it asks again", () => {
  it.each([
    [403, "KEY_SCOPE_FORBIDDEN"],
    [404, "NOT_FOUND"],
  ])("a refused answer (%i) is not asked again, under the app's retry", async (status, code) => {
    answering(refused(status, code));
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(appClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(asked).toHaveLength(1);
  });

  it.each([
    ["a 500 answer", refused(500, "INTERNAL_ERROR")],
    ["a failed connection", () => HttpResponse.error()],
  ])("%s is asked again once, as the app's retry says", async (_case, respond) => {
    answering(respond);
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(appClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(asked).toHaveLength(2);
  });

  it.each([
    ["none", false, 1],
    ["a count of 2", 2, 3],
    ["a rule that allows two", (failures: number) => failures < 2, 3],
    ["unset — the query library's own 3", undefined, 4],
  ])("any other failure follows the app's default retry, whatever its form: %s", async (_case, retry, reads) => {
    answering(refused(500, "INTERNAL_ERROR"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry, retryDelay: 0, gcTime: 0 } },
    });
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(asked).toHaveLength(reads);
  });
});

describe("useUsage — read again when the usage changes by itself", () => {
  // The simulated clock: every delay is counted from this instant.
  const NOW = Date.parse("2026-10-20T09:45:30.000Z");
  const WINDOW = { start: "2026-10-20T06:00:00.000Z", end: "2026-10-20T12:00:00.000Z" };
  const COMPUTE = { limit_seconds: 3600, used_seconds: 720, window: WINDOW };
  // A fast run's return, before the window's end.
  const RESETS_AT = "2026-10-20T10:20:00.000Z";
  // The end of the window that follows WINDOW.
  const NEXT_END = "2026-10-20T18:00:00.000Z";
  const HOUR = 3_600_000;
  const SIX_HOURS = 6 * HOUR;
  const iso = (ms: number) => new Date(ms).toISOString();

  // Each request the server answered, at the browser's time: when, its status, and the end of the window it gave.
  const served: Array<{ at: number; status: number; end?: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    served.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  });

  /** Answers every read with these quotas. */
  function answeringQuotas(quotas: unknown) {
    answering(() => {
      served.push({ at: Date.now(), status: 200 });
      return HttpResponse.json({ plan: "free", quotas } as UsageResponse);
    });
  }

  /**
   * The answer of a server whose clock reads `its`: its compute window of 6 h
   * aligned on UTC, as the route's are — with `fast`, a fast run that returns
   * at RESETS_AT by its clock, and none after.
   */
  function windowAnswer(its: number, fast: boolean): UsageResponse {
    const start = Math.floor(its / SIX_HOURS) * SIX_HOURS;
    return {
      plan: "free",
      quotas: {
        concurrent_runs: null,
        compute: { ...COMPUTE, window: { start: iso(start), end: iso(start + SIX_HOURS) } },
        fast_runs: fast
          ? {
              limit: 20,
              remaining: 14,
              resets_at: its < Date.parse(RESETS_AT) ? RESETS_AT : null,
            }
          : null,
      },
    };
  }

  /**
   * A server whose clock is `behind` ms behind the browser's. `failing` gives,
   * for the server's time, the status it fails with — `null` to answer.
   */
  function serverBehind(
    behind: number,
    { fast = false, failing }: { fast?: boolean; failing?: (its: number) => number | null } = {},
  ) {
    answering(() => {
      const at = Date.now();
      const status = failing?.(at - behind) ?? null;
      if (status !== null) {
        served.push({ at, status });
        return HttpResponse.json({ error: { code: "DOWN", message: "no" } }, { status });
      }
      const body = windowAnswer(at - behind, fast);
      served.push({ at, status: 200, end: body.quotas?.compute?.window.end });
      return HttpResponse.json(body);
    });
  }

  /** The reads the server saw: its requests grouped by instant — a failed read with its retry. */
  function readsOf(list: typeof served) {
    const reads: Array<{ at: number; status: number; end?: string; requests: number }> = [];
    for (const request of list) {
      const last = reads.at(-1);
      if (last && last.at === request.at) {
        last.requests += 1;
        last.status = request.status;
        last.end = request.end;
      } else {
        reads.push({ ...request, requests: 1 });
      }
    }
    return reads;
  }

  /** A compute window that ended `ago` ms before NOW. */
  function computeEnded(ago: number) {
    return { ...COMPUTE, window: { start: iso(NOW - ago - SIX_HOURS), end: iso(NOW - ago) } };
  }

  /** Lets the real clock run until `check` holds, a second and a half at most; the caller asserts. */
  async function until(check: () => boolean) {
    const deadline = performance.now() + 1_500;
    while (!check() && performance.now() < deadline) {
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
  }

  /** Moves the simulated clock on by `ms`, firing what falls due. */
  async function advance(ms: number) {
    await act(() => vi.advanceTimersByTimeAsync(ms));
  }

  /** Whether a read is under way. */
  function reading(client: QueryClient): boolean {
    return client.getQueryState(USAGE_QUERY_KEY)?.fetchStatus === "fetching";
  }

  /** Mounts the hook under the app's defaults and waits for its first read. */
  async function mounted() {
    const client = appClient();
    const { result, rerender } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });
    await until(() => client.getQueryState(USAGE_QUERY_KEY)?.status === "success");
    expect(asked).toHaveLength(1);
    return { client, result, rerender };
  }

  /** Mounts the hook under the app's defaults and waits for its first read to fail. */
  async function mountedFailing() {
    const client = appClient();
    const { result, rerender } = renderHook(() => useUsage(), { wrapper: wrapperOf(client) });
    await until(
      () => client.getQueryState(USAGE_QUERY_KEY)?.status === "error" && !reading(client),
    );
    expect(client.getQueryState(USAGE_QUERY_KEY)?.status).toBe("error");
    return { client, result, rerender };
  }

  /**
   * Moves the simulated clock on to the next timed read, to the millisecond,
   * and waits for its outcome; `false` when no read is set.
   */
  async function nextTimedRead(client: QueryClient): Promise<boolean> {
    if (vi.getTimerCount() === 0) return false;
    await act(() => vi.advanceTimersToNextTimerAsync());
    await until(() => !reading(client));
    return true;
  }

  /** The delay from `from` to the read for the instant `at`. */
  function readAt(at: string, from: number): number {
    return Date.parse(at) - from + USAGE_REREAD_MARGIN_MS;
  }

  it("at the end of the compute window: one read at that instant, none before, none after", async () => {
    serverBehind(0);
    const { client } = await mounted();

    await advance(readAt(WINDOW.end, NOW) - 1);
    expect(reading(client)).toBe(false);
    expect(asked).toHaveLength(1);

    await advance(1);
    await until(() => asked.length === 2 && !reading(client));
    expect(asked).toHaveLength(2);
    expect(served[1].end).toBe(NEXT_END);

    // Its answer gives the next window: nothing more is read before that window's end.
    const second = NOW + readAt(WINDOW.end, NOW);
    await advance(readAt(NEXT_END, second) - 1);
    expect(asked).toHaveLength(2);
  });

  it("the nearer of the two instants first — a fast run's return —, then the window's end", async () => {
    serverBehind(0, { fast: true });
    const { client } = await mounted();

    await advance(readAt(RESETS_AT, NOW) - 1);
    expect(asked).toHaveLength(1);
    await advance(1);
    await until(() => asked.length === 2 && !reading(client));
    expect(asked).toHaveLength(2);

    const second = NOW + readAt(RESETS_AT, NOW);
    await advance(readAt(WINDOW.end, second) - 1);
    expect(asked).toHaveLength(2);
    await advance(1);
    await until(() => asked.length === 3 && !reading(client));
    expect(asked).toHaveLength(3);
  });

  it.each([
    ["no quota", null],
    [
      "no compute bound, no pool",
      { concurrent_runs: { limit: 2, in_use: 1 }, compute: null, fast_runs: null },
    ],
    [
      "instants that are not texts",
      {
        concurrent_runs: null,
        compute: { ...COMPUTE, window: { start: 0, end: 2030 } },
        fast_runs: { limit: 20, remaining: 19, resets_at: 2030 },
      },
    ],
  ])("%s: no instant known, nothing read again", async (_case, quotas) => {
    answeringQuotas(quotas);
    await mounted();

    await advance(30 * 24 * HOUR);
    expect(asked).toHaveLength(1);
  });

  it("in a background tab too: the read at the instant does not wait for the tab to come back", async () => {
    serverBehind(0);
    const { client } = await mounted();
    focusManager.setFocused(false);

    await advance(readAt(WINDOW.end, NOW));
    await until(() => asked.length === 2 && !reading(client));
    expect(asked).toHaveLength(2);
  });

  it("an instant further than a timer can hold: no read before the longest delay", async () => {
    // A window of 30 days, as an operator may set it.
    const end = new Date(NOW + 30 * 24 * HOUR).toISOString();
    answeringQuotas({
      concurrent_runs: null,
      compute: { ...COMPUTE, window: { start: WINDOW.start, end } },
      fast_runs: null,
    });
    const { client } = await mounted();

    // A delay past what a timer holds would fire at once, and again every millisecond.
    await advance(1_000);
    expect(reading(client)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("a render between the instant and its read keeps the read, still the margin after the instant", async () => {
    serverBehind(0);
    const { client, rerender } = await mounted();
    // Halfway between the window's end and its read.
    const halfway = Date.parse(WINDOW.end) - NOW + USAGE_REREAD_MARGIN_MS / 2;

    await advance(halfway);
    rerender();
    await advance(Math.max(0, readAt(WINDOW.end, NOW) - halfway - 1));
    expect(reading(client)).toBe(false);
    expect(asked).toHaveLength(1);
    await advance(1);
    await until(() => asked.length === 2 && !reading(client));
    expect(asked).toHaveLength(2);
  });

  describe("a read nothing has followed is never dropped", () => {
    it("a timer held back past its moment — a hidden tab — and a render before it fires: the read is made at once", async () => {
      serverBehind(0);
      const { client, rerender } = await mounted();

      // The read is due at the window's end plus the margin; the browser holds its timer back.
      vi.setSystemTime(Date.parse(WINDOW.end) + 40_000);
      rerender();
      await advance(1);
      await until(() => asked.length === 2 && !reading(client));
      expect(asked).toHaveLength(2);
      expect(served[1].end).toBe(NEXT_END);
    });

    it("while a read is under way, no timer is set: its outcome sets the next", async () => {
      serverBehind(0);
      const { client } = await mounted();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      answering(async () => {
        await held;
        return HttpResponse.json(windowAnswer(Date.now(), false));
      });

      await advance(readAt(WINDOW.end, NOW));
      await until(() => asked.length === 2);
      expect(reading(client)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      release();
      await until(() => !reading(client));
      // Its answer, the next window: one read set, at its end.
      expect(vi.getTimerCount()).toBe(1);
    });

    it("while a read waits for the network, no timer is set", async () => {
      serverBehind(0);
      const { client } = await mounted();
      onlineManager.setOnline(false);

      await advance(readAt(WINDOW.end, NOW));
      expect(client.getQueryState(USAGE_QUERY_KEY)?.fetchStatus).toBe("paused");
      expect(vi.getTimerCount()).toBe(0);
      expect(asked).toHaveLength(1);

      onlineManager.setOnline(true);
      await until(
        () => asked.length === 2 && client.getQueryState(USAGE_QUERY_KEY)?.fetchStatus === "idle",
      );
      expect(asked).toHaveLength(2);
    });
  });

  describe("after a failure — any but a refusal: read again after a wait that grows, 5 s to 5 min", () => {
    it("a server down 30 s at the window's end: read again from 5 s on, and the usage comes back without a remount", async () => {
      const end = Date.parse(WINDOW.end);
      serverBehind(0, { failing: (its) => (its >= end && its < end + 30_000 ? 500 : null) });
      const { client, result } = await mounted();

      for (let i = 0; i < 10 && served.at(-1)?.end !== NEXT_END; i++) {
        expect(await nextTimedRead(client)).toBe(true);
      }
      const reads = readsOf(served).slice(1);
      const failed = reads.filter((read) => read.status === 500);
      expect(failed.length).toBeGreaterThanOrEqual(2);
      // Each failed read asked twice: the app's one retry.
      expect(failed.map((read) => read.requests)).toEqual(failed.map(() => 2));
      // Each wait as long as the failures have lasted, 5 s at least.
      const waits = reads.slice(1).map((read, i) => read.at - reads[i].at);
      expect(waits).toEqual(
        reads
          .slice(0, -1)
          .map((read) => Math.min(Math.max(read.at - failed[0].at, 5_000), 300_000)),
      );
      expect(reads.at(-1)).toMatchObject({ status: 200, end: NEXT_END });

      // What the hook hands on, once rendered: the next window, no error.
      await until(() => result.current.data?.quotas?.compute?.window.end === NEXT_END);
      expect(result.current.error).toBeNull();
      expect(result.current.data?.quotas?.compute?.window.end).toBe(NEXT_END);
    });

    it("a second outage starts again at 5 s, not where the first one stopped", async () => {
      // Down for the first 30 s of each window, by the server's clock.
      serverBehind(0, { failing: (its) => (its % SIX_HOURS < 30_000 ? 500 : null) });
      const { client } = await mounted();
      for (let i = 0; i < 10 && served.at(-1)?.end !== NEXT_END; i++) {
        expect(await nextTimedRead(client)).toBe(true);
      }
      expect(served.at(-1)?.end).toBe(NEXT_END);

      // That window's end: its read fails, and the next is 5 s after.
      expect(await nextTimedRead(client)).toBe(true);
      expect(await nextTimedRead(client)).toBe(true);
      const [failedAgain, after] = readsOf(served).slice(-2);
      expect(failedAgain.status).toBe(500);
      expect(failedAgain.at).toBeGreaterThan(Date.parse(NEXT_END));
      expect(after.at - failedAgain.at).toBe(5_000);
    });

    it("a server down from the first read on: never two reads within 5 s, the wait capped at 5 min, no usage", async () => {
      serverBehind(0, { failing: () => 500 });
      const { client, result } = await mountedFailing();

      for (let i = 0; i < 11; i++) expect(await nextTimedRead(client)).toBe(true);
      const reads = readsOf(served);
      expect(reads).toHaveLength(12);
      expect(reads.map((read) => read.requests)).toEqual(reads.map(() => 2));
      const waits = reads.slice(1).map((read, i) => read.at - reads[i].at);
      expect(waits).toEqual(
        reads.slice(0, -1).map((read) => Math.min(Math.max(read.at - reads[0].at, 5_000), 300_000)),
      );
      expect(Math.min(...waits)).toBe(5_000);
      expect(Math.max(...waits)).toBe(300_000);
      await until(() => result.current.isError);
      expect(result.current.isError).toBe(true);
      expect(result.current.data).toBeUndefined();
    });

    it("the first read fails and the server answers 12 s later: the usage comes without a remount", async () => {
      serverBehind(0, { failing: (its) => (its < NOW + 12_000 ? 500 : null) });
      const { client, result } = await mountedFailing();

      for (let i = 0; i < 5 && readsOf(served).at(-1)?.status !== 200; i++) {
        expect(await nextTimedRead(client)).toBe(true);
      }
      expect(readsOf(served).map((read) => [read.at - NOW, read.status])).toEqual([
        [0, 500],
        [5_000, 500],
        [10_000, 500],
        [20_000, 200],
      ]);
      await until(() => result.current.isSuccess);
      expect(result.current.data?.quotas?.compute?.window.end).toBe(WINDOW.end);
    });

    it("its read held back past its moment — a hidden tab — and a render: made at once", async () => {
      serverBehind(0, { failing: (its) => (its < NOW + 60_000 ? 500 : null) });
      const { client, rerender } = await mountedFailing();

      // The read again is due 5 s after the failure; the browser holds its timer back.
      vi.setSystemTime(NOW + 70_000);
      rerender();
      await advance(1);
      await until(() => readsOf(served).length === 2 && !reading(client));
      expect(readsOf(served).map((read) => [read.at - NOW, read.status])).toEqual([
        [0, 500],
        [70_001, 200],
      ]);
    });

    it("a network failure is read again too", async () => {
      let down = true;
      answering(() => {
        served.push({ at: Date.now(), status: down ? 0 : 200 });
        return down ? HttpResponse.error() : HttpResponse.json(windowAnswer(Date.now(), false));
      });
      const { client, result } = await mountedFailing();
      down = false;

      expect(await nextTimedRead(client)).toBe(true);
      expect(readsOf(served).map((read) => [read.at - NOW, read.status])).toEqual([
        [0, 0],
        [5_000, 200],
      ]);
      await until(() => result.current.isSuccess);
      expect(result.current.isSuccess).toBe(true);
    });

    it("a refusal at the first read: that read alone, never another", async () => {
      answering(refused(403, "KEY_SCOPE_FORBIDDEN"));
      await mountedFailing();
      expect(asked).toHaveLength(1);

      await advance(24 * HOUR);
      expect(asked).toHaveLength(1);
    });

    it("a refusal at the instant's read: never read again", async () => {
      const end = Date.parse(WINDOW.end);
      serverBehind(0, { failing: (its) => (its >= end ? 403 : null) });
      const { client } = await mounted();

      expect(await nextTimedRead(client)).toBe(true);
      expect(readsOf(served).at(-1)).toMatchObject({ status: 403, requests: 1 });
      await advance(24 * HOUR);
      expect(asked).toHaveLength(2);
    });
  });

  describe("an instant already past when the answer comes — the server's clock behind the browser's", () => {
    it("a server 3 s behind: read again until it gives the next window, never twice within 5 s, then at that window's end", async () => {
      serverBehind(3_000);
      const { client, result } = await mounted();

      for (let i = 0; i < 10 && served.at(-1)?.end !== NEXT_END; i++) {
        expect(await nextTimedRead(client)).toBe(true);
      }
      const after = served.filter((read) => read.at >= Date.parse(WINDOW.end));
      expect(after.length).toBeGreaterThanOrEqual(2);
      expect(after.slice(0, -1).map((read) => read.end)).toEqual(
        after.slice(0, -1).map(() => WINDOW.end),
      );
      expect(after.at(-1)?.end).toBe(NEXT_END);
      for (let i = 1; i < after.length; i++) {
        expect(after[i].at - after[i - 1].at).toBeGreaterThanOrEqual(5_000);
      }
      // What the hook hands on, once rendered.
      await until(() => result.current.data?.quotas?.compute?.window.end === NEXT_END);
      expect(result.current.data?.quotas?.compute?.window.end).toBe(NEXT_END);

      // The next window known: the next read is at its end, none before.
      expect(await nextTimedRead(client)).toBe(true);
      expect(served.at(-1)?.at).toBeGreaterThan(Date.parse(NEXT_END));
    });

    it("a server 1 s behind: the read after the window's end gives the next window at once", async () => {
      serverBehind(1_000);
      const { client } = await mounted();

      expect(await nextTimedRead(client)).toBe(true);
      expect(served).toHaveLength(2);
      // Not before the server is past the instant: its answer is the next window.
      expect(served[1].at).toBeGreaterThanOrEqual(Date.parse(WINDOW.end) + 1_000);
      expect(served[1].end).toBe(NEXT_END);

      // Nothing more before that window's end.
      expect(await nextTimedRead(client)).toBe(true);
      expect(served[2].at).toBeGreaterThan(Date.parse(NEXT_END));
    });

    it.each([
      ["2 s", "5 s", 2_000, 5_000],
      ["a minute", "a minute", 60_000, 60_000],
      ["20 min", "5 min", 20 * 60_000, 5 * 60_000],
    ])("past by %s: read again %s after the answer, not before", async (_past, _wait, ago, wait) => {
      answeringQuotas({ concurrent_runs: null, compute: computeEnded(ago), fast_runs: null });
      const { client } = await mounted();

      await advance(wait - 1);
      expect(reading(client)).toBe(false);
      expect(asked).toHaveLength(1);
      await advance(1);
      await until(() => asked.length === 2 && !reading(client));
      expect(asked).toHaveLength(2);
    });

    it("a server that keeps giving it: read again after as long as has passed since it, 5 s at least, 5 min at most", async () => {
      const ago = 2_000;
      answeringQuotas({ concurrent_runs: null, compute: computeEnded(ago), fast_runs: null });
      const { client } = await mounted();

      for (let i = 0; i < 12; i++) expect(await nextTimedRead(client)).toBe(true);
      expect(served).toHaveLength(13);
      const instant = NOW - ago;
      const gaps = served.slice(1).map((read, i) => read.at - served[i].at);
      const sinceInstant = served
        .slice(0, -1)
        .map((read) => Math.min(Math.max(read.at - instant, 5_000), 5 * 60_000));
      expect(gaps).toEqual(sinceInstant);
      expect(Math.min(...gaps)).toBe(5_000);
      expect(Math.max(...gaps)).toBe(5 * 60_000);
    });

    it("a render while it waits does not put the read back", async () => {
      // Past by a minute: read again a minute after the answer.
      answeringQuotas({ concurrent_runs: null, compute: computeEnded(60_000), fast_runs: null });
      const { client, rerender } = await mounted();

      await advance(30_000);
      rerender();
      await advance(30_000 - 1);
      expect(asked).toHaveLength(1);
      await advance(1);
      await until(() => asked.length === 2 && !reading(client));
      expect(asked).toHaveLength(2);
    });

    it.each([
      ["past by 20 min, a fast run back in 1 min: the fast run's", 20 * 60_000, 60_000, 62_000],
      ["past by 2 s, a fast run back in 30 min: 5 s after the answer", 2_000, 30 * 60_000, 5_000],
    ])("with an instant still to come, the nearer read wins — %s", async (_case, ago, back, wait) => {
      answeringQuotas({
        concurrent_runs: null,
        compute: computeEnded(ago),
        fast_runs: { limit: 20, remaining: 14, resets_at: iso(NOW + back) },
      });
      const { client } = await mounted();

      expect(await nextTimedRead(client)).toBe(true);
      expect(served[1].at - NOW).toBe(wait);
    });
  });
});

const INSTANCE: InstanceResponse = {
  links: {
    docs: "https://docs.example.com",
    terms: "https://example.com/legal/terms",
    privacy: "/legal/privacy",
  },
};

/** Answers every read of the instance with `respond`, each read counted. */
function answeringInstance(respond: () => Response | Promise<Response>) {
  server.use(
    http.get("/api/instance", ({ request }) => {
      asked.push({ method: request.method, path: new URL(request.url).pathname });
      return respond();
    }),
  );
}

/** The hook, and the links the dashboard takes from its answer. */
function useInstanceAndLinks() {
  const query = useInstance();
  return { query, links: instanceLinks(query.data) };
}

describe("useInstance", () => {
  it("reads GET /api/instance and hands back its body as it is", async () => {
    answeringInstance(() => HttpResponse.json(INSTANCE));
    const { result } = renderHook(() => useInstance(), { wrapper: wrapperOf(clientWith(30_000)) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(INSTANCE);
    expect(asked).toEqual([{ method: "GET", path: "/api/instance" }]);
  });

  it("is read once per session: never stale, so a second reader asks nothing", async () => {
    answeringInstance(() => HttpResponse.json(INSTANCE));
    const client = clientWith(0);
    const first = renderHook(() => useInstance(), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    const second = renderHook(() => useInstance(), { wrapper: wrapperOf(client) });
    expect(second.result.current.data).toEqual(INSTANCE);
    expect(second.result.current.isStale).toBe(false);
    expect(asked).toHaveLength(1);
    const query = client.getQueryCache().find({ queryKey: ["instance"] });
    expect((query?.options as { staleTime?: number } | undefined)?.staleTime).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it.each([
    ["a 500 answer", refused(500, "INTERNAL_ERROR")],
    ["a failed connection", () => HttpResponse.error()],
  ])("%s is asked again once, as the app's retry says", async (_case, respond) => {
    answeringInstance(respond);
    const { result } = renderHook(() => useInstance(), { wrapper: wrapperOf(appClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(asked).toHaveLength(2);
  });
});

describe("instanceLinks — the links the dashboard shows", () => {
  it("the answer's links, as they are", async () => {
    answeringInstance(() => HttpResponse.json(INSTANCE));
    const { result } = renderHook(useInstanceAndLinks, { wrapper: wrapperOf(clientWith(30_000)) });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.links).toEqual(INSTANCE.links);
  });

  it("the server's default answer: /docs, and no terms nor privacy link", async () => {
    answeringInstance(() =>
      HttpResponse.json({ links: { docs: "/docs", terms: null, privacy: null } }),
    );
    const { result } = renderHook(useInstanceAndLinks, { wrapper: wrapperOf(clientWith(30_000)) });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.links).toEqual({ docs: "/docs", terms: null, privacy: null });
  });

  it("before the answer arrives: /docs, and no terms nor privacy link", async () => {
    answeringInstance(() => HttpResponse.json(INSTANCE));
    const { result } = renderHook(useInstanceAndLinks, { wrapper: wrapperOf(clientWith(30_000)) });

    expect(result.current.query.isPending).toBe(true);
    expect(result.current.links).toEqual({ docs: "/docs", terms: null, privacy: null });
    await waitFor(() => expect(result.current.links).toEqual(INSTANCE.links));
  });

  it.each([
    ["a failed connection", () => HttpResponse.error()],
    ["a 500 answer", refused(500, "INTERNAL_ERROR")],
  ])("%s: /docs, and no terms nor privacy link", async (_case, respond) => {
    answeringInstance(respond);
    const { result } = renderHook(useInstanceAndLinks, { wrapper: wrapperOf(clientWith(30_000)) });

    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.links).toEqual({ docs: "/docs", terms: null, privacy: null });
  });

  it.each([
    ["an object with no links", {}],
    ["links that are not an object", { links: "https://docs.example.com" }],
    ["links set to null", { links: null }],
    [
      "fields that are not strings",
      { links: { docs: 42, terms: { href: "https://x/t" }, privacy: ["https://x/p"] } },
    ],
    ["a body that is not an object", "https://docs.example.com"],
  ])("an answer of an unexpected shape — %s: /docs, and no terms nor privacy link", async (_case, body) => {
    answeringInstance(() => HttpResponse.json(body));
    const { result } = renderHook(useInstanceAndLinks, { wrapper: wrapperOf(clientWith(30_000)) });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.links).toEqual({ docs: "/docs", terms: null, privacy: null });
  });

  it("each field on its own: a string kept, the others fallen back", async () => {
    answeringInstance(() =>
      HttpResponse.json({ links: { docs: 7, terms: "https://example.com/t", privacy: false } }),
    );
    const { result } = renderHook(useInstanceAndLinks, { wrapper: wrapperOf(clientWith(30_000)) });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.links).toEqual({
      docs: "/docs",
      terms: "https://example.com/t",
      privacy: null,
    });
  });
});
