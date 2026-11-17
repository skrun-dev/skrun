/**
 * Object-storage keys for what a cloud run leaves in the bucket.
 *
 * One definition, shared by everything that names these objects: the harness
 * that uploads a run's output files, the archive URL presigned for the sandbox,
 * and any code that later has to find or delete them. Keys built in two places
 * drift, and an object whose key drifted is one nothing will ever delete.
 *
 * The prefix starts with an underscore on purpose. Bundles live in the same
 * bucket under `<namespace>/<name>/<version>.agent`, and a namespace is a
 * lowercase `[a-z0-9-]` segment: a segment outside that alphabet can never be
 * anyone's namespace, so a lifecycle rule or a cleanup scoped to this prefix
 * can never reach a bundle. A bare `runs/` could — `runs` is a valid namespace.
 *
 * Keys are plain concatenation, never normalised: a `..` segment in a name
 * reaches the store as it is — the storage client does not resolve it either.
 * What the store then does is its own: R2 and MinIO both refuse such a key, on
 * a write, a read and a delete alike, rather than keep it or resolve it. That
 * refusal is not a property to build on. Whether a name taken from a run's file
 * list may become a key is the output name rule's to say
 * (`outputNameRefusal`, `files/output-rules.ts`), and it belongs to whoever
 * turns a name into a key to apply it first.
 */

/** Prefix of every object a run writes to storage. */
export const RUN_OUTPUTS_PREFIX = "_runs/";

function runKeyPrefix(runId: string): string {
  return `${RUN_OUTPUTS_PREFIX}${runId}/`;
}

/** Key of one output file of a run: `_runs/<runId>/outputs/<name>`. */
export function runOutputKey(runId: string, name: string): string {
  return `${runKeyPrefix(runId)}outputs/${name}`;
}

/** Key of a run's outputs archive: `_runs/<runId>/outputs.tar.gz`. */
export function runOutputsArchiveKey(runId: string): string {
  return `${runKeyPrefix(runId)}outputs.tar.gz`;
}
