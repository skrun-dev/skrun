import { utimesSync } from "node:fs";

/**
 * Set a path's modification time to `atMs`: the time it carries for the orphan
 * pass, which removes a path no live process holds only once two sweep
 * intervals have passed that time. A registered file carries its deadline; a
 * file held with no deadline yet carries now plus its window, set again at
 * every sweep. Usually ahead of now: common filesystems store a time ahead as
 * they store any other (one with 32-bit timestamps brings a time past 2038 back
 * to its limit, still ahead). A path already gone is left so.
 *
 * Two limits remain. A filesystem that refuses a time ahead leaves a live file
 * removable two intervals after its last write. And the pass knows a run's
 * output directory by its name only: another program making
 * `skrun-outputs-<uuid>` directories under the same temp root — an embedding
 * of the runtime's local adapter, which makes its own when no directory is
 * given — would see them removed. The server's routes always give one: the
 * directory a run holds.
 */
export function setRemovableAfter(path: string, atMs: number): void {
  const at = new Date(atMs);
  try {
    utimesSync(path, at, at);
  } catch {
    // Nothing to protect.
  }
}
