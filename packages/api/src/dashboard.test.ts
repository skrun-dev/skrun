import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDashboardConfig, warnDashboardDirMissing } from "./dashboard.js";

describe("resolveDashboardConfig", () => {
  it("defaults to enabled, served from ../web/dist (VT-5)", () => {
    expect(resolveDashboardConfig({})).toEqual({ enabled: true, dir: "../web/dist" });
  });

  it("disables on off/false/0, case-insensitive (VT-3)", () => {
    for (const v of ["off", "OFF", "Off", "false", "FALSE", "0", " off "]) {
      expect(resolveDashboardConfig({ SKRUN_DASHBOARD: v }).enabled).toBe(false);
    }
  });

  it("stays enabled for on/1/yes/true/empty/unset (VT-3)", () => {
    expect(resolveDashboardConfig({}).enabled).toBe(true);
    for (const v of ["on", "1", "yes", "true", ""]) {
      expect(resolveDashboardConfig({ SKRUN_DASHBOARD: v }).enabled).toBe(true);
    }
  });

  it("uses SKRUN_DASHBOARD_DIR when set, else the cwd-relative default", () => {
    expect(resolveDashboardConfig({ SKRUN_DASHBOARD_DIR: "/opt/skrun-web/dist" }).dir).toBe(
      "/opt/skrun-web/dist",
    );
    expect(resolveDashboardConfig({}).dir).toBe("../web/dist");
  });
});

describe("warnDashboardDirMissing (Q-3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs exactly one warning naming SKRUN_DASHBOARD_DIR + the dir", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnDashboardDirMissing("/no/such/dir");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain("SKRUN_DASHBOARD_DIR");
    expect(msg).toContain("/no/such/dir");
  });
});
