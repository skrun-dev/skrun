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
        return new HttpResponse(new Blob(["bytes"]), { status: 200 });
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
