// FlyioAdapter — runs each `POST /run` inside a dedicated Fly.io Machine.
// Public exports for use by the API layer and admin CLI.

export type { FlyioAdapterOptions, PresignedStorageAdapter } from "./adapter.js";
export { FlyioAdapter } from "./adapter.js";
export type {
  CreateMachineRequest,
  FlyMachinesApiOptions,
  Machine,
  MachineConfig,
  MachineState,
} from "./fly-api.js";
export { FlyMachinesApi, ListMachinesResponseSchema, MachineSchema } from "./fly-api.js";
export type { BuildMachineConfigInput } from "./machine-config.js";
export {
  buildMachineConfig,
  buildPoolMachineConfig,
  machineNameForPool,
  machineNameForRun,
  POOL_MACHINE_NAME_PREFIX,
} from "./machine-config.js";
export type { OutputManifestEntry, OutputsUploadOptions } from "./outputs-upload.js";
export { uploadOutputs } from "./outputs-upload.js";
export type {
  PooledMachine,
  PooledMachineState,
  RunnerPoolOptions,
  RunnerPoolStats,
} from "./pool.js";
export { RunnerPool } from "./pool.js";
export type { RunnerAuthDecision, RunnerAuthState, RunnerCredentials } from "./rpc-auth.js";
export { authorizeRunnerRequest, isRpcAuthorized } from "./rpc-auth.js";
export { RpcMcpToolProvider } from "./rpc-mcp-provider.js";
export type { RpcToolProviderOptions } from "./rpc-script-provider.js";
export { RpcScriptToolProvider } from "./rpc-script-provider.js";
