// Shared formatters used across dashboard pages.

/**
 * Format a USD amount for display in the dashboard.
 *
 * Rules:
 *   - 0 → "$0.00"
 *   - 0 < value < 0.005 → "<$0.01" (sub-cent saves remain visible)
 *   - otherwise → "$X.XX" (2 decimals, locale-independent)
 *
 * Mirrors the precision contract of NUMERIC(10,6) USD columns: aggregate
 * sums preserve sub-cent accuracy, but the display rounds to cents.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || value === 0) return "$0.00";
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * Compute a delta percent label between current and previous values.
 *
 * Rules:
 *   - previous === 0 → "—" (em dash, no baseline to compare against)
 *   - rounded percent === 0 → "0%"
 *   - positive → "+X%", negative → "-X%"
 *
 * The em dash mirrors the empty-cell convention used elsewhere in the
 * dashboard (model column, duration cell, etc.) and reads cleaner than
 * "new" for tiles where any value can appear (cost saved, runs, tokens).
 */
export function computeDeltaPercent(
  current: number | null | undefined,
  previous: number | null | undefined,
): string {
  if (previous == null || previous === 0) return "—";
  const cur = current ?? 0;
  const pct = Math.round(((cur - previous) / previous) * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}
