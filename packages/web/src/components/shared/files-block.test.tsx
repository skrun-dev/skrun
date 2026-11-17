import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test-utils";
import { FilesBlock, type RunFile } from "./files-block";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  // jsdom doesn't provide createObjectURL / revokeObjectURL.
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:mock-url"),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

describe("FilesBlock", () => {
  it("renders nothing when files is empty or undefined", () => {
    const { container, rerender } = renderWithProviders(<FilesBlock files={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FilesBlock files={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FilesBlock files={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each file with name and human-readable size", () => {
    const files: RunFile[] = [
      { name: "report.pdf", size: 1024 * 64, file_id: "fil_abc123" },
      { name: "data.csv", size: 512, file_id: "fil_def456" },
    ];
    renderWithProviders(<FilesBlock files={files} />);
    expect(screen.getByText("Files (2)")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(screen.getByText(/64\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/512 B/)).toBeInTheDocument();
  });

  it("triggers an authed fetch to /api/files/:id/content on Download click", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x70, 0x64, 0x66]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );

    try {
      renderWithProviders(
        <FilesBlock files={[{ name: "report.pdf", size: 9, file_id: "fil_abc123" }]} />,
      );

      await user.click(screen.getByRole("button", { name: /Download/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/files/fil_abc123/content",
          expect.objectContaining({ credentials: "same-origin" }),
        );
      });
      await waitFor(() => {
        expect(URL.createObjectURL).toHaveBeenCalled();
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the legacy per-run url when file_id is missing", async () => {
    const user = userEvent.setup();
    let hitUrl: string | null = null;
    server.use(
      http.get("/api/runs/:run_id/files/:filename", ({ params }) => {
        hitUrl = `/api/runs/${params.run_id}/files/${params.filename}`;
        return new HttpResponse("bytes", { status: 200 });
      }),
    );

    renderWithProviders(
      <FilesBlock files={[{ name: "out.txt", size: 5, url: "/api/runs/r1/files/out.txt" }]} />,
    );

    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => {
      expect(hitUrl).toBe("/api/runs/r1/files/out.txt");
    });
  });

  it("shows an inline error when the server returns a non-2xx response", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/files/:id/content", () =>
        HttpResponse.json(
          { error: { code: "FILE_NOT_FOUND", message: "File 'fil_x' not found or expired" } },
          { status: 404 },
        ),
      ),
    );

    renderWithProviders(
      <FilesBlock files={[{ name: "missing.pdf", size: 1, file_id: "fil_x" }]} />,
    );

    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/File 'fil_x' not found or expired/);
    });
  });

  it("shows an error when no file_id and no url are available", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FilesBlock files={[{ name: "orphan.bin", size: 2 }]} />);
    await user.click(screen.getByRole("button", { name: /Download/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/No download URL available/);
    });
  });
});

/** A presigned object-storage URL: another origin than the dashboard's. */
const PRESIGNED = "https://objects.example/bucket/_runs/r1/outputs/report.pdf?X-Amz-Signature=abc";

/** Every URL `fetch` was called with, resolved against the page. */
function fetchedUrls(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([input]) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    return new URL(raw, window.location.href).href;
  });
}

function otherOrigins(urls: string[]): string[] {
  return urls.filter((url) => new URL(url).origin !== window.location.origin);
}

/** Records each anchor click instead of letting jsdom navigate. */
function watchAnchorClicks(): Array<{ href: string; download: boolean }> {
  const clicks: Array<{ href: string; download: boolean }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.hasAttribute("download") });
  });
  return clicks;
}

describe("FilesBlock — a link of another origin is navigated to, never fetched", () => {
  // The store answers too, so that a component which did fetch it would get
  // bytes, and fail on the assertion about origins rather than on a network error.
  beforeEach(() => {
    server.use(http.get("https://objects.example/*", () => new HttpResponse("%PDF")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks this API for a fresh link, then navigates to the presigned one", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/runs/:run_id/files/:filename/link", () =>
        HttpResponse.json({ url: PRESIGNED, expires_at: "2026-10-01T12:15:00.000Z" }),
      ),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const clicks = watchAnchorClicks();

    renderWithProviders(
      <FilesBlock files={[{ name: "report.pdf", size: 9, url: PRESIGNED }]} runId="r1" />,
    );
    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(otherOrigins(fetchedUrls(fetchSpy))).toEqual([]);
    expect(fetchedUrls(fetchSpy)).toContain(
      new URL("/api/runs/r1/files/report.pdf/link", window.location.href).href,
    );
    expect(clicks[0]).toEqual({ href: PRESIGNED, download: false });
  });

  it("encodes the file's name, a path included, in the link route", async () => {
    const user = userEvent.setup();
    let asked: string | null = null;
    server.use(
      http.get("/api/runs/:run_id/files/:filename/link", ({ request }) => {
        asked = new URL(request.url).pathname;
        return HttpResponse.json({ url: PRESIGNED, expires_at: null });
      }),
    );
    watchAnchorClicks();

    renderWithProviders(<FilesBlock files={[{ name: "d/b.csv", size: 1 }]} runId="r1" />);
    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => expect(asked).toBe("/api/runs/r1/files/d%2Fb.csv/link"));
  });

  it("fetches a same-origin link with the caller's credentials, and saves it", async () => {
    const user = userEvent.setup();
    let served = false;
    server.use(
      http.get("/api/runs/:run_id/files/:filename/link", () =>
        HttpResponse.json({ url: "/api/runs/r1/files/out.txt", expires_at: null }),
      ),
      http.get("/api/runs/r1/files/out.txt", () => {
        served = true;
        return new HttpResponse("bytes", { status: 200 });
      }),
    );
    const clicks = watchAnchorClicks();

    renderWithProviders(<FilesBlock files={[{ name: "out.txt", size: 5 }]} runId="r1" />);
    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(served).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clicks[0]).toEqual({ href: "blob:mock-url", download: true });
  });

  it("navigates to a presigned URL a run carried, without a run to ask, and fetches nothing", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const clicks = watchAnchorClicks();

    renderWithProviders(<FilesBlock files={[{ name: "report.pdf", size: 9, url: PRESIGNED }]} />);
    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(otherOrigins(fetchedUrls(fetchSpy))).toEqual([]);
    expect(clicks[0]).toEqual({ href: PRESIGNED, download: false });
  });

  it("shows the API's message when the link is refused", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/runs/:run_id/files/:filename/link", () =>
        HttpResponse.json(
          {
            error: {
              code: "FILE_EXPIRED",
              message: "The output files of run r1 are no longer kept",
            },
          },
          { status: 410 },
        ),
      ),
    );
    const clicks = watchAnchorClicks();

    renderWithProviders(<FilesBlock files={[{ name: "report.pdf", size: 9 }]} runId="r1" />);
    await user.click(screen.getByRole("button", { name: /Download/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/no longer kept/);
    });
    expect(clicks).toEqual([]);
  });
});
