/**
 * What a log line may say about an error: its class, its code and its HTTP
 * status, never its message. The API's import point for the runtime's
 * errorFields — one implementation for the API, the runtime and the runner.
 */
export { type ErrorFields, errorFields } from "@skrun-dev/runtime";
