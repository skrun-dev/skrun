// VT-17 — Import dialog accepts namespace + version as form fields and
// dispatches the import via the explicit values (not by parsing the
// filename). The slug pre-fills from a filename heuristic; namespace
// pre-fills from `useMe().namespace`.
//
// Tests the post-#84 rewrite that closed the pre-existing
// import-dialog-filename-mis-parse bug.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test-utils";
import { ImportDialog } from "./import-dialog";

const server = setupServer(
  http.get("/api/me", () =>
    HttpResponse.json({
      id: "u-tarcroi",
      username: "tarcroi",
      namespace: "tarcroi",
      email: null,
      avatar_url: null,
      plan: "free",
      role: "user",
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function buildBundleFile(name: string) {
  // Minimal blob — server-side validation is mocked. The component only
  // cares about File metadata (name, arrayBuffer) for routing.
  return new File([new Uint8Array([0x1f, 0x8b, 0x08])], name, { type: "application/octet-stream" });
}

describe("ImportDialog UploadTab — VT-17 form fields replace filename parsing", () => {
  it("VT-17a: pre-fills namespace from /api/me", async () => {
    renderWithProviders(<ImportDialog open onClose={() => {}} />);
    const ns = await screen.findByLabelText<HTMLInputElement>("Namespace");
    await waitFor(() => {
      expect(ns.value).toBe("tarcroi");
    });
  });

  it("VT-17b: pre-fills name (slug) and version from the picked filename", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportDialog open onClose={() => {}} />);
    await screen.findByLabelText("Namespace");

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput as HTMLInputElement, buildBundleFile("email-drafter-1.0.0.agent"));

    const nameInput = screen.getByLabelText<HTMLInputElement>("Name (slug)");
    const versionInput = screen.getByLabelText<HTMLInputElement>("Version");
    expect(nameInput.value).toBe("email-drafter");
    expect(versionInput.value).toBe("1.0.0");
  });

  it("VT-17c: submits with namespace+name+version from form, NOT from filename parse", async () => {
    let capturedNamespace = "";
    let capturedName = "";
    let capturedVersion = "";
    let capturedContentType = "";
    server.use(
      http.post("/api/agents/:ns/:name/push", ({ request, params }) => {
        capturedNamespace = String(params.ns);
        capturedName = String(params.name);
        const url = new URL(request.url);
        capturedVersion = url.searchParams.get("version") ?? "";
        capturedContentType = request.headers.get("content-type") ?? "";
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ImportDialog open onClose={() => {}} />);
    await screen.findByLabelText("Namespace");

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    await user.upload(fileInput as HTMLInputElement, buildBundleFile("email-drafter-1.0.0.agent"));

    // Auto-pre-fill happened; user clicks Import.
    const importBtn = screen.getByRole("button", { name: "Import" });
    await user.click(importBtn);

    await waitFor(() => {
      expect(capturedNamespace).toBe("tarcroi");
    });
    expect(capturedName).toBe("email-drafter");
    expect(capturedVersion).toBe("1.0.0");
    expect(capturedContentType).toBe("application/octet-stream");
  });

  it("VT-17d: namespace field is read-only (cross-namespace import disabled)", async () => {
    // Locked in post-#80: cross-namespace import via the dashboard is gone.
    // Even an admin pushing under namespace=bob would create an agent owned
    // by admin.id — the real Bob would be filtered out of his own namespace
    // by the multi-tenant gate (orphaned agent). The field is therefore
    // tied to the caller's account; if a true admin cross-namespace need
    // emerges, it goes through the API (`curl POST .../push`) with the
    // owner_id rewrite story discussed first.
    let capturedNamespace = "";
    server.use(
      http.post("/api/agents/:ns/:name/push", ({ params }) => {
        capturedNamespace = String(params.ns);
        return new HttpResponse(null, { status: 200 });
      }),
    );

    renderWithProviders(<ImportDialog open onClose={() => {}} />);
    const nsInput = await screen.findByLabelText<HTMLInputElement>("Namespace");
    await waitFor(() => {
      expect(nsInput.value).toBe("tarcroi");
    });

    // Field must be read-only — no override attempts succeed.
    expect(nsInput.readOnly).toBe(true);

    // Submit the form: the captured namespace MUST match the pre-fill from
    // useMe (`tarcroi`), not anything the user could have typed.
    const user = userEvent.setup();
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    await user.upload(fileInput as HTMLInputElement, buildBundleFile("seo-audit-2.1.3.agent"));

    const importBtn = screen.getByRole("button", { name: "Import" });
    await user.click(importBtn);

    await waitFor(() => {
      expect(capturedNamespace).toBe("tarcroi");
    });
  });

  it("VT-17e: does NOT parse the filename to derive namespace (regression guard)", async () => {
    // Pre-#84 bug: `email-drafter-1.0.0.agent` was mis-parsed as
    // namespace=email, name=drafter. The rewrite must use the form-field
    // namespace (from useMe / user override) instead.
    let capturedNamespace = "";
    server.use(
      http.post("/api/agents/:ns/:name/push", ({ params }) => {
        capturedNamespace = String(params.ns);
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ImportDialog open onClose={() => {}} />);
    await screen.findByLabelText("Namespace");

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    await user.upload(fileInput as HTMLInputElement, buildBundleFile("email-drafter-1.0.0.agent"));
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(capturedNamespace).toBe("tarcroi");
    });
    // The pre-#84 bug would have sent namespace=email. Assert that
    // ghost behavior is gone.
    expect(capturedNamespace).not.toBe("email");
  });
});
