import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../lib/auth";
import { renderWithProviders } from "../test-utils";
import { PlaygroundPage } from "./playground";

const server = setupServer(
  http.get("/api/agents/dev/test-agent", () =>
    HttpResponse.json({
      name: "test-agent",
      namespace: "dev",
      description: "A test agent for playground",
      verified: false,
      run_count: 0,
      token_count: 0,
      created_at: "2026-04-21T00:00:00Z",
      updated_at: "2026-04-21T00:00:00Z",
    }),
  ),
  http.get("/api/agents/dev/test-agent/versions", () => HttpResponse.json({ versions: [] })),
  http.get("/api/agents/dev/nonexistent", () =>
    HttpResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
  ),
  http.get("/api/agents/dev/nonexistent/versions", () =>
    HttpResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPlayground(ns: string, name: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/agents/:namespace/:name/run" element={<PlaygroundPage />} />
    </Routes>,
    { route: `/agents/${ns}/${name}/run` },
  );
}

describe("PlaygroundPage", () => {
  it("UAT-7: renders with agent context", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      expect(screen.getAllByText("dev/test-agent").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Playground").length).toBeGreaterThan(0);
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
  });

  it("shows input textarea with default JSON", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      const textarea = screen.getByDisplayValue("{}");
      expect(textarea).toBeInTheDocument();
    });
  });

  it("EC-3: shows error for nonexistent agent", async () => {
    renderPlayground("dev", "nonexistent");
    await waitFor(() => {
      expect(screen.getByText("Agent not found")).toBeInTheDocument();
      expect(screen.getByText("Back to agents")).toBeInTheDocument();
    });
  });

  // ── Bug G: no JSON-mode "Attach file" button ────────────────────────

  it("does not render an 'Attach file' button in JSON mode", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Attach file/i })).not.toBeInTheDocument();
  });

  it("renders a Form-mode hint when the agent has file-typed inputs", async () => {
    server.use(
      http.get("/api/agents/dev/multimodal-agent", () =>
        HttpResponse.json({
          name: "multimodal-agent",
          namespace: "dev",
          description: "Takes a file input",
          verified: false,
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/multimodal-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              pushed_at: "2026-04-21T00:00:00Z",
              size: 1,
              config_snapshot: {
                inputs: [
                  { name: "audio", type: "file", media: "audio" },
                  { name: "title", type: "string" },
                ],
              },
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "multimodal-agent");
    await waitFor(() => {
      expect(screen.getByText(/This agent takes file inputs\. Switch to/)).toBeInTheDocument();
    });
  });

  it("hides the Form-mode hint for agents with no file inputs", async () => {
    renderPlayground("dev", "test-agent");
    await waitFor(() => {
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/This agent takes file inputs/)).not.toBeInTheDocument();
  });

  // ── Per-version Run gating (Phase 7.5 — AC-20, UAT-26..28) ─────────────

  it("UAT-26: Run button is disabled when the selected (latest) version is unverified", async () => {
    server.use(
      http.get("/api/agents/dev/gated", () =>
        HttpResponse.json({
          name: "gated",
          namespace: "dev",
          description: "",
          latest_version_verified: false,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/gated/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: false,
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "gated");

    await waitFor(() => {
      expect(screen.getByText(/Run agent/)).toBeInTheDocument();
    });
    const runBtn = screen.getByRole("button", { name: /Run agent/ });
    expect(runBtn).toBeDisabled();
    expect(runBtn).toHaveAttribute("aria-disabled", "true");
    expect(runBtn).toHaveAttribute("aria-describedby", "run-disabled-reason");
  });

  it("AC-20: amber banner with link to versions table is rendered when unverified", async () => {
    server.use(
      http.get("/api/agents/dev/gated", () =>
        HttpResponse.json({
          name: "gated",
          namespace: "dev",
          description: "",
          latest_version_verified: false,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/gated/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: false,
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "gated");

    await waitFor(() => {
      expect(screen.getByText(/is not verified/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/View versions table/i)).toBeInTheDocument();
    // The sr-only span carries the screen-reader explanation
    expect(screen.getByText(/must be verified by an admin/i)).toBeInTheDocument();
  });

  it("UAT-26 (positive): Run button is enabled when the selected version is verified", async () => {
    server.use(
      http.get("/api/agents/dev/ok", () =>
        HttpResponse.json({
          name: "ok",
          namespace: "dev",
          description: "",
          latest_version_verified: true,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 0,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/ok/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1024,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: true,
            },
          ],
        }),
      ),
    );
    renderPlayground("dev", "ok");

    await waitFor(() => {
      const runBtn = screen.getByRole("button", { name: /Run agent/ });
      expect(runBtn).not.toBeDisabled();
    });
    expect(screen.queryByText(/is not verified/i)).not.toBeInTheDocument();
  });
});

/** An agent whose one version is verified: the Run button is live under any policy. */
function verifiedAgent(name: string) {
  return [
    http.get(`/api/agents/dev/${name}`, () =>
      HttpResponse.json({
        name,
        namespace: "dev",
        description: "",
        latest_version_verified: true,
        latest_version: "1.0.0",
        versions: ["1.0.0"],
        run_count: 0,
        token_count: 0,
        created_at: "2026-04-21T00:00:00Z",
        updated_at: "2026-04-21T00:00:00Z",
      }),
    ),
    http.get(`/api/agents/dev/${name}/versions`, () =>
      HttpResponse.json({
        versions: [
          {
            version: "1.0.0",
            size: 1,
            pushed_at: "2026-04-21T00:00:00Z",
            notes: null,
            verified: true,
          },
        ],
      }),
    ),
  ];
}

/** The agent's run, answered as a stream of these events. */
function streamedRun(name: string, events: object[]) {
  return http.post(
    `/api/agents/dev/${name}/run`,
    () =>
      new HttpResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
}

/** An agent whose one version is not verified. */
function unverifiedAgent(name: string) {
  return [
    http.get(`/api/agents/dev/${name}`, () =>
      HttpResponse.json({
        name,
        namespace: "dev",
        description: "",
        latest_version_verified: false,
        latest_version: "1.0.0",
        versions: ["1.0.0"],
        run_count: 0,
        token_count: 0,
        created_at: "2026-04-21T00:00:00Z",
        updated_at: "2026-04-21T00:00:00Z",
      }),
    ),
    http.get(`/api/agents/dev/${name}/versions`, () =>
      HttpResponse.json({
        versions: [
          {
            version: "1.0.0",
            size: 1,
            pushed_at: "2026-04-21T00:00:00Z",
            notes: null,
            verified: false,
          },
        ],
      }),
    ),
  ];
}

/** The signed-in caller, under the operator's verification `policy`. */
function signedInUnder(policy: "admin" | "owner" | "disabled") {
  return http.get("/api/me", () =>
    HttpResponse.json({
      id: "u1",
      username: "dev",
      namespace: "dev",
      role: "user",
      verification_policy: policy,
    }),
  );
}

describe("PlaygroundPage — the Run button follows the verification policy", () => {
  it.each([
    "owner",
    "disabled",
  ] as const)("lets an unverified version run under the %s policy, with no banner", async (policy) => {
    server.use(signedInUnder(policy), ...unverifiedAgent("unverified-agent"));
    renderPlayground("dev", "unverified-agent");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );
    expect(screen.queryByText(/is not verified/i)).not.toBeInTheDocument();
  });

  it("keeps an unverified version from running under the admin policy", async () => {
    server.use(signedInUnder("admin"), ...unverifiedAgent("unverified-agent"));
    renderPlayground("dev", "unverified-agent");

    expect(await screen.findByText(/is not verified/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run agent/ })).toBeDisabled();
  });
});

describe("PlaygroundPage — the files of a run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads a file through a fresh link for the run it just ran", async () => {
    const presigned = "https://objects.example/bucket/_runs/run-pg-1/outputs/report.pdf?sig=x";
    let asked: string | null = null;
    server.use(
      ...verifiedAgent("files-agent"),
      streamedRun("files-agent", [
        { type: "run_start", run_id: "run-pg-1" },
        {
          type: "run_complete",
          run_id: "run-pg-1",
          output: { ok: true },
          files: [{ name: "report.pdf", size: 3, url: presigned }],
        },
      ]),
      http.get("/api/runs/:run_id/files/:filename/link", ({ request }) => {
        asked = new URL(request.url).pathname;
        return HttpResponse.json({ url: presigned, expires_at: "2026-10-01T12:15:00.000Z" });
      }),
      http.get("https://objects.example/*", () => new HttpResponse("%PDF")),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const clicks: Array<{ href: string; download: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ href: this.href, download: this.hasAttribute("download") });
    });
    const user = userEvent.setup();

    renderPlayground("dev", "files-agent");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /Run agent/ }));
    await user.click(await screen.findByRole("button", { name: /^Download$/ }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    const fetched = fetchSpy.mock.calls.map(
      ([input]) =>
        new URL(String(input instanceof Request ? input.url : input), window.location.href),
    );
    expect(fetched.filter((url) => url.origin !== window.location.origin)).toEqual([]);
    expect(asked).toBe("/api/runs/run-pg-1/files/report.pdf/link");
    expect(clicks[0]).toEqual({ href: presigned, download: false });
  });
});

describe("PlaygroundPage — a run that fails", () => {
  /** Runs the agent, whose stream ends with `runError`, and waits for the failed state. */
  async function runToError(name: string, runError: object) {
    server.use(
      ...verifiedAgent(name),
      streamedRun(name, [
        { type: "run_start", run_id: "run-err-1" },
        { type: "run_error", run_id: "run-err-1", ...runError },
      ]),
    );
    const user = userEvent.setup();
    renderPlayground("dev", name);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /Run agent/ }));
  }

  /** The page's error box: a paragraph (the event list shows its lines in spans). */
  async function errorBox(text: string): Promise<HTMLElement | undefined> {
    const matches = await screen.findAllByText(text);
    return matches.find((element) => element.tagName === "P");
  }

  it("shows the message of the error the run ended with, and the page stays", async () => {
    await runToError("error-agent", {
      error: { code: "PROVIDER_ERROR", message: "The model refused the request" },
    });

    expect(await errorBox("The model refused the request")).toBeDefined();
    expect(screen.getByRole("button", { name: /Run agent/ })).toBeInTheDocument();
  });

  it("shows an error sent as a plain string", async () => {
    await runToError("string-error-agent", { error: "Agent crashed" });

    expect(await errorBox("Agent crashed")).toBeDefined();
  });

  it("shows a generic message for an error with no readable message", async () => {
    await runToError("odd-error-agent", { error: { code: "X", message: { nested: true } } });

    expect(await errorBox("Agent execution failed")).toBeDefined();
    expect(screen.getByRole("button", { name: /Run agent/ })).toBeInTheDocument();
  });
});

describe("PlaygroundPage — the event list writes each event as text", () => {
  /** Runs the agent, whose stream is `events`. */
  async function runStreamed(name: string, events: object[]) {
    server.use(...verifiedAgent(name), streamedRun(name, events));
    const user = userEvent.setup();
    renderPlayground("dev", name);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: /Run agent/ }));
  }

  it("writes a failed run's error by its code and message, never as [object Object]", async () => {
    await runStreamed("event-error-agent", [
      { type: "run_start", run_id: "run-ev-1" },
      {
        type: "run_error",
        run_id: "run-ev-1",
        error: { code: "PROVIDER_ERROR", message: "The model refused the request" },
      },
    ]);

    // The event list shows its lines in spans; the error box is a paragraph.
    expect(
      await screen.findByText("PROVIDER_ERROR: The model refused the request", {
        selector: "span",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("writes a run's structured output as JSON, never as [object Object]", async () => {
    await runStreamed("event-output-agent", [
      { type: "run_start", run_id: "run-ev-2" },
      {
        type: "run_complete",
        run_id: "run-ev-2",
        output: { answer: "forty-two", count: 2 },
        files: [],
      },
    ]);

    expect(
      await screen.findByText('{"answer":"forty-two","count":2}', { selector: "span" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("writes an error sent as a plain string as it is", async () => {
    await runStreamed("event-string-error-agent", [
      { type: "run_start", run_id: "run-ev-3" },
      { type: "run_error", run_id: "run-ev-3", error: "Agent crashed" },
    ]);

    expect(await screen.findByText("Agent crashed", { selector: "span" })).toBeInTheDocument();
  });
});

describe("PlaygroundPage — the end of a run refreshes the account's usage", () => {
  /** Renders the playground with the account's usage already read, kept in the cache. */
  async function renderWithUsage(name: string) {
    const rendered = renderPlayground("dev", name);
    rendered.queryClient.setQueryDefaults(["usage"], { gcTime: Number.POSITIVE_INFINITY });
    rendered.queryClient.setQueryData(["usage"], { plan: "free", quotas: null });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );
    expect(rendered.queryClient.getQueryState(["usage"])?.isInvalidated).toBe(false);
    return rendered;
  }

  /** Whether the account's usage has been marked for a fresh read. */
  function usageInvalidated(queryClient: ReturnType<typeof renderPlayground>["queryClient"]) {
    return queryClient.getQueryState(["usage"])?.isInvalidated === true;
  }

  it("a run that completes", async () => {
    server.use(
      ...verifiedAgent("usage-complete-agent"),
      streamedRun("usage-complete-agent", [
        { type: "run_start", run_id: "run-u-1" },
        { type: "run_complete", run_id: "run-u-1", output: { ok: true }, files: [] },
      ]),
    );
    const { queryClient } = await renderWithUsage("usage-complete-agent");

    await userEvent.setup().click(screen.getByRole("button", { name: /Run agent/ }));

    await waitFor(() => expect(usageInvalidated(queryClient)).toBe(true));
    expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a run that fails", async () => {
    server.use(
      ...verifiedAgent("usage-error-agent"),
      streamedRun("usage-error-agent", [
        { type: "run_start", run_id: "run-u-2" },
        {
          type: "run_error",
          run_id: "run-u-2",
          error: { code: "PROVIDER_ERROR", message: "The model refused the request" },
        },
      ]),
    );
    const { queryClient } = await renderWithUsage("usage-error-agent");

    await userEvent.setup().click(screen.getByRole("button", { name: /Run agent/ }));

    await waitFor(() => expect(usageInvalidated(queryClient)).toBe(true));
    expect(screen.getByRole("alert")).toHaveTextContent("The model refused the request");
  });

  it("a run the server refuses for a quota", async () => {
    server.use(
      ...verifiedAgent("usage-refused-agent"),
      http.post("/api/agents/dev/usage-refused-agent/run", () =>
        HttpResponse.json(
          {
            error: {
              code: "CONCURRENCY_LIMIT_REACHED",
              message: "2 runs in progress on this account; your plan allows 2.",
            },
          },
          { status: 429, headers: { "Retry-After": "10" } },
        ),
      ),
    );
    const { queryClient } = await renderWithUsage("usage-refused-agent");

    await userEvent.setup().click(screen.getByRole("button", { name: /Run agent/ }));

    await waitFor(() => expect(usageInvalidated(queryClient)).toBe(true));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "2 runs in progress on this account; your plan allows 2.",
    );
  });

  it("a run whose connection fails", async () => {
    server.use(
      ...verifiedAgent("usage-cut-agent"),
      http.post("/api/agents/dev/usage-cut-agent/run", () => HttpResponse.error()),
    );
    const { queryClient } = await renderWithUsage("usage-cut-agent");

    await userEvent.setup().click(screen.getByRole("button", { name: /Run agent/ }));

    await waitFor(() => expect(usageInvalidated(queryClient)).toBe(true));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("a run stopped with Stop", async () => {
    server.use(
      ...verifiedAgent("usage-stop-agent"),
      http.post(
        "/api/agents/dev/usage-stop-agent/run",
        ({ request }) =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                const started = { type: "run_start", run_id: "run-u-5" };
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(started)}\n\n`),
                );
                // The stream stays open until the run is stopped.
                request.signal.addEventListener("abort", () =>
                  controller.error(new DOMException("The run was stopped", "AbortError")),
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    const { queryClient } = await renderWithUsage("usage-stop-agent");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Run agent/ }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(usageInvalidated(queryClient)).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PlaygroundPage — a run's error is announced", () => {
  it("the error a run ends with is in an alert", async () => {
    server.use(
      ...verifiedAgent("alert-error-agent"),
      streamedRun("alert-error-agent", [
        { type: "run_start", run_id: "run-a-1" },
        {
          type: "run_error",
          run_id: "run-a-1",
          error: { code: "PROVIDER_ERROR", message: "The model refused the request" },
        },
      ]),
    );
    renderPlayground("dev", "alert-error-agent");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: /Run agent/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The model refused the request");
  });

  it("a quota's refusal is in an alert, with the server's words", async () => {
    server.use(
      ...verifiedAgent("alert-refused-agent"),
      http.post("/api/agents/dev/alert-refused-agent/run", () =>
        HttpResponse.json(
          {
            error: {
              code: "COMPUTE_QUOTA_EXCEEDED",
              message: "3600 s used of 3600 in this window; it resets at 12:00 UTC.",
            },
          },
          { status: 429, headers: { "Retry-After": "600" } },
        ),
      ),
    );
    renderPlayground("dev", "alert-refused-agent");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );

    await userEvent.setup().click(screen.getByRole("button", { name: /Run agent/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "3600 s used of 3600 in this window; it resets at 12:00 UTC.",
    );
  });
});

describe("PlaygroundPage — the model key, kept in app memory only", () => {
  // The name the dashboard up to 1.2.1 kept the key under in `localStorage`.
  const LEGACY_KEY_STORAGE = "skrun-llm-key";

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function SignOut() {
    const { logout } = useAuth();
    return (
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    );
  }

  /** The Playground among other dashboard pages, under the app's providers. */
  function renderDashboard(route: string, runPage: ReactNode = <p>run page</p>) {
    return renderWithProviders(
      <>
        <nav>
          <Link to="/runs/r1">to run</Link>
          <Link to="/agents/dev/test-agent/run">to playground</Link>
        </nav>
        <Routes>
          <Route path="/agents/:namespace/:name/run" element={<PlaygroundPage />} />
          <Route path="/runs/:id" element={runPage} />
        </Routes>
        <SignOut />
      </>,
      { route },
    );
  }

  /** Every value both Web Storages hold. */
  function storedValues(): string[] {
    return [localStorage, sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i) ?? "") ?? ""),
    );
  }

  it("typing the key writes it to no Web Storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderDashboard("/agents/dev/test-agent/run");
    const field = await screen.findByLabelText(/LLM API key/);

    await userEvent.setup().type(field, "sk-typed-secret");

    expect(field).toHaveValue("sk-typed-secret");
    // What the field says of it.
    expect(
      screen.getByText("Kept in this tab's memory only — gone on reload or sign-out."),
    ).toBeInTheDocument();
    const writes = setItem.mock.calls.filter(
      ([name, value]) => name === LEGACY_KEY_STORAGE || String(value).includes("sk-typed"),
    );
    expect(writes).toEqual([]);
    expect(storedValues().filter((value) => value.includes("sk-typed"))).toEqual([]);
  });

  it("a key an earlier dashboard left in localStorage is removed at load and never fills the field", async () => {
    localStorage.setItem(LEGACY_KEY_STORAGE, "legacy-key");
    renderDashboard("/agents/dev/test-agent/run");

    const field = await screen.findByLabelText(/LLM API key/);
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY_STORAGE)).toBeNull());
    expect(field).toHaveValue("");
  });

  it("a Storage that throws does not stop the dashboard from loading", async () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    renderDashboard("/agents/dev/test-agent/run");

    expect(await screen.findByLabelText(/LLM API key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run agent/ })).toBeInTheDocument();
  });

  it("the key outlives a move to another page and back", async () => {
    const user = userEvent.setup();
    renderDashboard("/agents/dev/test-agent/run");
    await user.type(await screen.findByLabelText(/LLM API key/), "sk-kept-in-memory");

    await user.click(screen.getByRole("link", { name: "to run" }));
    expect(await screen.findByText("run page")).toBeInTheDocument();
    expect(screen.queryByLabelText(/LLM API key/)).toBeNull();
    await user.click(screen.getByRole("link", { name: "to playground" }));

    expect(await screen.findByLabelText(/LLM API key/)).toHaveValue("sk-kept-in-memory");
  });

  it("sign-out clears the key", async () => {
    server.use(http.post("/auth/logout", () => new HttpResponse(null, { status: 204 })));
    const user = userEvent.setup();
    renderDashboard("/agents/dev/test-agent/run");
    const field = await screen.findByLabelText(/LLM API key/);
    await user.type(field, "sk-before-sign-out");
    // A plain object, so sign-out's `location.href = "/login"` does not reach
    // jsdom. Stubbed only now: the page's own requests resolve against it.
    vi.stubGlobal("location", { href: "" });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(location.href).toBe("/login"));
    expect(field).toHaveValue("");
  });

  it("a re-run from a run's page sends the run at once, with the key typed earlier under the agent's own provider", async () => {
    let sent: { body: unknown; key: string | null } | null = null;
    server.use(
      http.get("/api/agents/dev/rerun-agent", () =>
        HttpResponse.json({
          name: "rerun-agent",
          namespace: "dev",
          description: "",
          latest_version_verified: true,
          latest_version: "1.0.0",
          versions: ["1.0.0"],
          run_count: 1,
          token_count: 0,
          created_at: "2026-04-21T00:00:00Z",
          updated_at: "2026-04-21T00:00:00Z",
        }),
      ),
      http.get("/api/agents/dev/rerun-agent/versions", () =>
        HttpResponse.json({
          versions: [
            {
              version: "1.0.0",
              size: 1,
              pushed_at: "2026-04-21T00:00:00Z",
              notes: null,
              verified: true,
              config_snapshot: { model: { provider: "mistral", name: "test-model" } },
            },
          ],
        }),
      ),
      http.post("/api/agents/dev/rerun-agent/run", async ({ request }) => {
        sent = { body: await request.json(), key: request.headers.get("X-LLM-API-Key") };
        return new HttpResponse(
          [
            { type: "run_start", run_id: "run-again-1" },
            { type: "run_complete", run_id: "run-again-1", output: { ok: true }, files: [] },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    );
    const user = userEvent.setup();
    // The address a run's Re-run opens: its input in the query.
    const input = encodeURIComponent(JSON.stringify({ topic: "again" }));
    renderDashboard(
      "/agents/dev/rerun-agent/run",
      <Link to={`/agents/dev/rerun-agent/run?input=${input}`}>Re-run</Link>,
    );
    // The key typed once, then the run's page, then its Re-run.
    await user.type(await screen.findByPlaceholderText("API key for mistral"), "typed-key");
    await user.click(screen.getByRole("link", { name: "to run" }));
    await user.click(await screen.findByRole("link", { name: "Re-run" }));

    // The agent and its version read: the key field names the agent's provider.
    expect(await screen.findByPlaceholderText("API key for mistral")).toHaveValue("typed-key");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Run agent/ })).not.toBeDisabled(),
    );

    // Nothing touched: Run.
    await user.click(screen.getByRole("button", { name: /Run agent/ }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toEqual({
      body: { input: { topic: "again" } },
      key: JSON.stringify({ mistral: "typed-key" }),
    });
    await waitFor(() => expect(screen.getAllByText("completed").length).toBeGreaterThan(0));
    expect(screen.queryByText("running")).toBeNull();
  });
});

describe("PlaygroundPage — the key field invites no password manager", () => {
  /** The class that masks a text field's characters, where the browser supports it. */
  const MASK = "[-webkit-text-security:disc]";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function keyField(): Promise<HTMLElement> {
    renderPlayground("dev", "test-agent");
    return screen.findByLabelText(/LLM API key/);
  }

  /** What tells password managers and the browser to leave the field alone. */
  function expectNoManagerInvited(field: HTMLElement) {
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    expect(field).toHaveAttribute("autocapitalize", "off");
    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("data-1p-ignore");
    expect(field).toHaveAttribute("data-lpignore", "true");
    expect(field).toHaveAttribute("data-bwignore");
    expect(field).toHaveAttribute("data-form-type", "other");
  }

  it("a browser that masks a text field gets a masked text field, never a password field", async () => {
    const supports = vi.fn(() => true);
    vi.stubGlobal("CSS", { supports });

    const field = await keyField();

    expect(supports).toHaveBeenCalledWith("-webkit-text-security", "disc");
    expect(field).toHaveAttribute("type", "text");
    expect(field.className).toContain(MASK);
    expectNoManagerInvited(field);
  });

  it("a browser that cannot mask one keeps a password field: the key is never shown in clear", async () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });

    const field = await keyField();

    expect(field).toHaveAttribute("type", "password");
    expect(field.className).not.toContain(MASK);
    expectNoManagerInvited(field);
  });

  it("without CSS.supports, or without CSS at all, the field stays a password field", async () => {
    vi.stubGlobal("CSS", {});
    expect(await keyField()).toHaveAttribute("type", "password");
    cleanup();

    vi.stubGlobal("CSS", undefined);
    expect(await keyField()).toHaveAttribute("type", "password");
  });
});

describe("PlaygroundPage — Copy as cURL asks for the event stream", () => {
  // The clipboard, watched: what the page copies is read back, never written anywhere.
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("the curl copied carries the header that asks for the stream", async () => {
    renderPlayground("dev", "test-agent");

    fireEvent.click(await screen.findByRole("button", { name: "Copy as cURL" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toMatch(/^curl -X POST \S+\/api\/agents\/dev\/test-agent\/run /);
    expect(copied).toContain('-H "Accept: text/event-stream"');
  });
});

/** An agent whose one version, verified, declares `inputs`. */
function agentDeclaring(name: string, inputs: object[]) {
  return [
    http.get(`/api/agents/dev/${name}`, () =>
      HttpResponse.json({
        name,
        namespace: "dev",
        description: "",
        latest_version_verified: true,
        latest_version: "1.0.0",
        versions: ["1.0.0"],
        run_count: 0,
        token_count: 0,
        created_at: "2026-04-21T00:00:00Z",
        updated_at: "2026-04-21T00:00:00Z",
      }),
    ),
    http.get(`/api/agents/dev/${name}/versions`, () =>
      HttpResponse.json({
        versions: [
          {
            version: "1.0.0",
            size: 1,
            pushed_at: "2026-04-21T00:00:00Z",
            notes: null,
            verified: true,
            config_snapshot: { inputs },
          },
        ],
      }),
    ),
  ];
}

// Any non-empty name is an input's name, `__proto__` too. Assigned to the
// object the JSON editor is parsed into, that name would set the object's
// prototype, and the field would leave the input: each field is defined.
describe("PlaygroundPage — an input the agent names __proto__ stays in the input", () => {
  /** The field `__proto__` of the JSON editor's input, read in JSON mode. */
  async function protoFieldOfEditor(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "JSON" }));
    const editor = document.querySelector("textarea");
    const input = JSON.parse(editor?.value ?? "{}");
    return Object.getOwnPropertyDescriptor(input, "__proto__")?.value;
  }

  it("a file attached in Form mode: the JSON editor carries it under that name", async () => {
    server.use(
      ...agentDeclaring("proto-file-agent", [{ name: "__proto__", type: "file", required: true }]),
      http.post("/api/files", () => HttpResponse.json({ file_id: "fil_proto_1", size: 3 })),
    );
    renderPlayground("dev", "proto-file-agent");
    const user = userEvent.setup({ applyAccept: false });
    await user.click(await screen.findByRole("button", { name: "Form" }));

    const picker = document.getElementById("input-__proto__") as HTMLInputElement;
    await user.upload(picker, new File(["abc"], "a.txt", { type: "text/plain" }));
    await screen.findByText("a.txt");

    expect(await protoFieldOfEditor(user)).toEqual({
      type: "file",
      source: "id",
      file_id: "fil_proto_1",
    });
  });

  it("a text typed in Form mode: the JSON editor carries it under that name", async () => {
    server.use(
      ...agentDeclaring("proto-text-agent", [
        { name: "__proto__", type: "string", required: true },
      ]),
    );
    renderPlayground("dev", "proto-text-agent");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Form" }));

    const field = document.getElementById("input-__proto__") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "hello" } });

    expect(await protoFieldOfEditor(user)).toBe("hello");
  });
});

// A text field shows the value the JSON editor's input carries under its name,
// as a field of its own: a name the input does not carry — whatever it is,
// the name of a member every object inherits included — shows an empty field.
describe("PlaygroundPage — a text input the editor does not carry shows empty, whatever its name", () => {
  it.each([
    "__proto__",
    "toString",
    "constructor",
    "hasOwnProperty",
  ])("an input named %s: empty in Form mode while the editor carries no such field, then the text typed into it", async (name) => {
    const agent = `inherited-name-agent-${name.replace(/_/g, "")}`;
    server.use(...agentDeclaring(agent, [{ name, type: "string", required: true }]));
    renderPlayground("dev", agent);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Form" }));

    const field = document.getElementById(`input-${name}`) as HTMLInputElement;
    expect(field.value).toBe("");

    fireEvent.change(field, { target: { value: "typed" } });
    expect(field.value).toBe("typed");
  });
});
