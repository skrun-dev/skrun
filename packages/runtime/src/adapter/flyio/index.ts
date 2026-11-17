// FlyioAdapter — runs each `POST /run` inside a dedicated Fly.io Machine.
// Public exports for use by the API layer and admin CLI.

export type { AcquisitionBudgetInput } from "./acquisition-budget.js";
export { acquisitionBudgetMs, seatDeadlineMarginMs } from "./acquisition-budget.js";
export type { FlyioAdapterOptions, PresignedStorageAdapter } from "./adapter.js";
export { FlyioAdapter } from "./adapter.js";
export type {
  CreateMachineRequest,
  CreateProgress,
  FlyCallOptions,
  FlyDestroyOptions,
  FlyMachinesApiOptions,
  Machine,
  MachineConfig,
  MachineDestroyOutcome,
  MachineState,
} from "./fly-api.js";
export {
  CREATE_DIRECT_RETRY_WAITS_MS,
  createWorstCaseMs,
  FLY_429_BACKOFF_MS,
  FLY_429_MAX_RETRIES,
  FLY_APP_ACTION_BURST,
  FLY_APP_ACTION_RATE_PER_S,
  FLY_RETRY_AFTER_CAP_MS,
  FlyMachinesApi,
  ListMachinesResponseSchema,
  MACHINE_LABEL_KEYS,
  MachineSchema,
  POOL_LABEL_KEY,
  RUN_LABEL_KEY,
  SEARCH_READS,
  SEARCH_SPACING_MS,
} from "./fly-api.js";
export { storageInfraHosts } from "./infra-hosts.js";
export type { BuildMachineConfigInput } from "./machine-config.js";
export {
  buildMachineConfig,
  buildPoolMachineConfig,
  machineNameForPool,
  machineNameForRun,
  POOL_MACHINE_NAME_PREFIX,
} from "./machine-config.js";
export type { MachineLifetimeInput } from "./machine-lifetime.js";
export {
  DEFAULT_RUN_TIMEOUT_MS,
  declaredLifetimeEndMs,
  declaredLifetimeMs,
  LIFETIME_END_KEY,
  MACHINE_LIFETIME_GRACE_MS,
  MAX_TIMER_DELAY_MS,
  machineLifetimeSeconds,
  RUNNER_LIFETIME_ENV,
  runLabelOf,
  undeclaredLifetimeFallbackMs,
} from "./machine-lifetime.js";
export type { ReleaseOutputBytes } from "./output-bytes-budget.js";
export {
  OUTPUT_BYTES_BUDGET,
  OutputBytesBudget,
  processOutputBytesBudget,
} from "./output-bytes-budget.js";
export { RUN_OUTPUTS_PREFIX, runOutputKey, runOutputsArchiveKey } from "./output-keys.js";
export type {
  OutputManifestEntry,
  OutputsUploadOptions,
  OutputsUploadStep,
} from "./outputs-upload.js";
export { OUTPUTS_UPLOAD_BUDGET_MS, OutputsUploadError, uploadOutputs } from "./outputs-upload.js";
export type {
  PooledMachine,
  PooledMachineState,
  RunnerPoolOptions,
  RunnerPoolStartOptions,
  RunnerPoolStats,
  RunnerPoolSweep,
  RunnerPoolSweepResult,
} from "./pool.js";
export { DEFAULT_STARTED_ORPHAN_WINDOW_MS, RunnerPool } from "./pool.js";
export type { RunnerAuthDecision, RunnerAuthState, RunnerCredentials } from "./rpc-auth.js";
export { authorizeRunnerRequest, isRpcAuthorized } from "./rpc-auth.js";
export { RpcMcpToolProvider } from "./rpc-mcp-provider.js";
export type { RpcToolProviderOptions } from "./rpc-script-provider.js";
export { RpcScriptToolProvider } from "./rpc-script-provider.js";
