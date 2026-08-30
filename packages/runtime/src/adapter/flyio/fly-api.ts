// Fly.io Machines REST API typed client.
//
// Hand-rolled by design: no widely-adopted official Node
// SDK for the Machines API as of 2026-05-23, so a small typed wrapper around
// native `fetch` + `zod` is cheaper than fighting an unmaintained dep. Surface
// is intentionally narrow — only the 5 endpoints FlyioAdapter uses.
//
// Rate limits per https://fly.io/docs/machines/api/working-with-machines-api/
// (Fly.io docs, checked 2026-05-23): 1 req/s per action, 3 burst; GET machine
// 5/s standard, 10/s burst. 429 responses use exponential backoff.
//
// Idempotency: the API has no Idempotency-Key header. The client tracks
// in-flight requests by `(method, path)` so a retry storm from concurrent
// callers can't fan out into duplicate POSTs.

import { z } from "zod";
import { MachineSpawnError } from "../../errors.js";

const FLY_API_BASE_URL = "https://api.machines.dev/v1";

// ---------- Zod schemas (response shapes) ----------

const MachineStateSchema = z.enum([
  "created",
  "starting",
  "started",
  "stopping",
  "stopped",
  // A machine paused with its memory snapshotted. Absent from this list until
  // 2026-08-19, which would have made `list()` throw a schema mismatch the moment
  // a suspended machine existed in the app — and the pre-warm pool suspends every
  // machine it holds. The surrounding object is passthrough, but this field is a
  // strict enum, so an unlisted value is a hard parse failure rather than an
  // ignored extra.
  "suspended",
  "suspending",
  "replacing",
  "destroying",
  "destroyed",
]);

const MachineConfigEnvSchema = z.record(z.string(), z.string()).optional();

const MachineServicePortSchema = z.object({
  port: z.number().int(),
  handlers: z.array(z.string()).optional(),
});

const MachineServiceSchema = z.object({
  protocol: z.string(),
  internal_port: z.number().int(),
  ports: z.array(MachineServicePortSchema).optional(),
});

const MachineMountSchema = z.object({
  volume: z.string(),
  path: z.string(),
});

const MachineRestartPolicySchema = z.object({
  policy: z.enum(["no", "always", "on-failure"]).optional(),
  max_retries: z.number().int().optional(),
});

// Machine "guest" config — VM resource specification. Required for our
// runtime image: the multi-runtime base + iptables setup + Node Hono
// server doesn't fit in Fly's default 256MB, and a 256MB machine stays
// in "created" state on boot (HTTP 408 deadline_exceeded). Surfaced
// during the first real-Fly cold-start run 2026-05-25.
export const MachineGuestSchema = z.object({
  cpu_kind: z.enum(["shared", "performance"]),
  cpus: z.number().int().positive(),
  memory_mb: z.number().int().positive(),
});

export const MachineConfigSchema = z.object({
  image: z.string(),
  env: MachineConfigEnvSchema,
  services: z.array(MachineServiceSchema).optional(),
  mounts: z.array(MachineMountSchema).optional(),
  restart: MachineRestartPolicySchema.optional(),
  guest: MachineGuestSchema.optional(),
  // Many additional fields exist on the Fly.io side (size, schedule, dns, ...)
  // — declared open via `.passthrough()` on the outer schema so we don't reject
  // legitimate responses we don't model yet.
});

export const MachineSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    state: MachineStateSchema,
    region: z.string().optional(),
    instance_id: z.string().optional(),
    private_ip: z.string().optional(),
    image_ref: z
      .object({
        registry: z.string().optional(),
        repository: z.string().optional(),
        tag: z.string().optional(),
        digest: z.string().optional(),
      })
      .partial()
      .optional(),
    config: MachineConfigSchema.optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

export const ListMachinesResponseSchema = z.array(MachineSchema);

// Start / Stop / Delete responses are typically empty or `{ok: true}`.
// We declare them open so we accept either shape without breakage.
const SimpleAckSchema = z.object({}).passthrough();

// ---------- Inferred types (public) ----------

export type MachineState = z.infer<typeof MachineStateSchema>;
export type MachineConfig = z.infer<typeof MachineConfigSchema>;
export type MachineGuest = z.infer<typeof MachineGuestSchema>;
export type Machine = z.infer<typeof MachineSchema>;

export interface CreateMachineRequest {
  name?: string;
  region?: string;
  config: MachineConfig;
}

// ---------- Retry/backoff config ----------

export interface FlyMachinesApiOptions {
  /** Base URL override (for tests / staging). Defaults to https://api.machines.dev/v1 */
  baseUrl?: string;
  /** Max retry attempts on 429. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each retry. Default 250. */
  backoffBaseMs?: number;
  /** Injectable fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

interface ResolvedOptions {
  baseUrl: string;
  maxRetries: number;
  backoffBaseMs: number;
  fetchImpl: typeof fetch;
}

// ---------- Client ----------

export class FlyMachinesApi {
  private readonly opts: ResolvedOptions;
  // Track in-flight (method, path) tuples so concurrent retry loops don't
  // double-fire mutating operations. Each entry is the in-flight promise so
  // callers can await the existing inflight rather than spawning a new one.
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly token: string,
    private readonly appName: string,
    options: FlyMachinesApiOptions = {},
  ) {
    this.opts = {
      baseUrl: options.baseUrl ?? FLY_API_BASE_URL,
      maxRetries: options.maxRetries ?? 3,
      backoffBaseMs: options.backoffBaseMs ?? 250,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    };
  }

  async create(request: CreateMachineRequest): Promise<Machine> {
    const machineName = request.name ?? "(unnamed)";
    return this.request(
      "POST",
      `/apps/${encodeURIComponent(this.appName)}/machines`,
      MachineSchema,
      machineName,
      "create",
      request,
    );
  }

  async start(machineId: string): Promise<void> {
    await this.request(
      "POST",
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/start`,
      SimpleAckSchema,
      machineId,
      "boot-probe",
      null,
    );
  }

  /**
   * Suspend a machine: pause it and snapshot its state, memory included, so the
   * next {@link start} resumes it instead of cold-booting.
   *
   * This is the only net-new call the pre-warm pool needs — {@link start} already
   * targets the endpoint Fly documents as the resume path, so waking a suspended
   * machine reuses it unchanged.
   *
   * Two caveats the caller must handle, both from Fly's own documentation:
   *  - the resume is attempted, **not guaranteed**; a start may silently cold-boot
   *    instead, which is indistinguishable from the API's point of view;
   *  - suspending many machines at once is discouraged, so a pool top-up must
   *    serialise these calls rather than fan them out.
   */
  async suspend(machineId: string): Promise<void> {
    await this.request(
      "POST",
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/suspend`,
      SimpleAckSchema,
      machineId,
      "boot-probe",
      null,
    );
  }

  async stop(machineId: string): Promise<void> {
    await this.request(
      "POST",
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/stop`,
      SimpleAckSchema,
      machineId,
      "boot-probe",
      null,
    );
  }

  async destroy(machineId: string): Promise<void> {
    // `force=true` — Fly's default DELETE refuses to delete a machine that
    // isn't already stopped (HTTP 412). At end-of-run the FlyioAdapter always
    // calls destroy() on a still-started machine (the auto-started state from
    // create()), so the test smoke (phase 18) AND production both need force.
    // Mocked tests don't catch this; surfaced during the first real-Fly smoke
    // run on 2026-05-25.
    await this.request(
      "DELETE",
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
      SimpleAckSchema,
      machineId,
      "boot-probe",
      null,
    );
  }

  async list(): Promise<Machine[]> {
    return this.request(
      "GET",
      `/apps/${encodeURIComponent(this.appName)}/machines`,
      ListMachinesResponseSchema,
      "(list)",
      "boot-probe",
      null,
    );
  }

  /**
   * Single private request method that handles auth, retry on 429, response
   * shape validation via zod, and typed error mapping. Centralises the policy.
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    contextName: string,
    failurePhase: "create" | "boot-probe" | "init-rpc",
    body: unknown,
  ): Promise<T> {
    const inflightKey = `${method} ${path}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing as Promise<T>;

    const run = this.runWithRetry<T>(method, path, schema, contextName, failurePhase, body);
    this.inflight.set(inflightKey, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(inflightKey);
    }
  }

  private async runWithRetry<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: z.ZodType<T>,
    contextName: string,
    failurePhase: "create" | "boot-probe" | "init-rpc",
    body: unknown,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const response = await this.opts.fetchImpl(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: body !== null ? JSON.stringify(body) : undefined,
        });

        if (response.status === 429 && attempt < this.opts.maxRetries) {
          const delay = this.opts.backoffBaseMs * 2 ** attempt;
          await sleep(delay);
          continue;
        }

        if (!response.ok) {
          const bodyText = await safeReadText(response);
          throw new MachineSpawnError(
            {
              machineName: contextName,
              machineId: failurePhase === "create" ? null : contextName,
              phase: failurePhase,
              httpStatus: response.status,
            },
            new Error(`Fly.io API ${method} ${path}: ${response.status} ${bodyText}`),
          );
        }

        // 204 No Content (DELETE) or empty body responses are common — guard
        // before parsing JSON to keep zod from choking on "".
        const text = await safeReadText(response);
        if (text === "") {
          return schema.parse({});
        }
        const parsed = schema.safeParse(JSON.parse(text));
        if (!parsed.success) {
          throw new MachineSpawnError(
            {
              machineName: contextName,
              machineId: failurePhase === "create" ? null : contextName,
              phase: failurePhase,
              httpStatus: response.status,
            },
            new Error(
              `Fly.io API ${method} ${path} response schema mismatch: ${parsed.error.message}`,
            ),
          );
        }
        return parsed.data;
      } catch (err) {
        lastErr = err;
        // Network errors get one retry path through the loop too (treated like
        // a 429). MachineSpawnError already wraps and re-throws so we don't
        // need to wrap again here.
        if (err instanceof MachineSpawnError) throw err;
        if (attempt < this.opts.maxRetries) {
          const delay = this.opts.backoffBaseMs * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        throw new MachineSpawnError(
          {
            machineName: contextName,
            machineId: failurePhase === "create" ? null : contextName,
            phase: failurePhase,
            httpStatus: null,
          },
          err,
        );
      }
    }
    // Exhausted retries on 429.
    throw new MachineSpawnError(
      {
        machineName: contextName,
        machineId: failurePhase === "create" ? null : contextName,
        phase: failurePhase,
        httpStatus: 429,
      },
      lastErr ??
        new Error(`Fly.io API ${method} ${path}: exhausted ${this.opts.maxRetries} retries on 429`),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
