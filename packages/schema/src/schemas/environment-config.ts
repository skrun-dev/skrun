import { z } from "zod";

export const NetworkingConfigSchema = z.object({
  allowed_hosts: z.array(z.string()).default([]),
});

export type NetworkingConfig = z.infer<typeof NetworkingConfigSchema>;

/**
 * The form of an `allowed_hosts` entry the cloud sandbox cannot enforce:
 *  - `pattern` — a host pattern (`*.slack.com`), which only the local runtime
 *    honours: it matches the names its harness connects to;
 *  - `host-port` — a host with a port (`example.com:443`);
 *  - `url` — a URL (`https://example.com`);
 *  - `path` — a host with a path (`example.com/api`);
 *  - `other` — anything else that is no host name the sandbox reads: an
 *    internationalised name, an `@`, a `%`, two names in one entry…
 * None but a pattern is honoured by any runtime: the local runtime compares an
 * entry to the bare name a request connects to.
 */
export type SandboxRefusedForm = "pattern" | "host-port" | "url" | "path" | "other";

/** An `allowed_hosts` entry the cloud sandbox cannot enforce: as written, and its form. */
export interface SandboxRefusedHost {
  host: string;
  form: SandboxRefusedForm;
}

/** A host name the sandbox reads: letters, digits, dots, hyphens and underscores. */
const SANDBOX_HOST_NAME = /^[A-Za-z0-9._-]+$/;
/** The characters an IPv6 literal is written in — embedded IPv4 included. */
const IPV6_CHARACTERS = /^[0-9A-Fa-f:.]+$/;

/** An entry as the sandbox reads it: its spaces taken out. */
function cleaned(host: string): string {
  return host.replaceAll(" ", "");
}

/** The address an entry is, without brackets, when it is an IPv6 literal — bare or in brackets. */
function ipv6Literal(entry: string): string | undefined {
  const bare = entry.startsWith("[") && entry.endsWith("]") ? entry.slice(1, -1) : entry;
  if (!bare.includes(":") || !IPV6_CHARACTERS.test(bare)) return undefined;
  // The URL parser's own reading of an IPv6 address, which every runtime ships.
  try {
    new URL(`http://[${bare}]/`);
    return bare;
  } catch {
    return undefined;
  }
}

/** The form of an entry the sandbox cannot enforce, its spaces taken out. */
function refusedFormOf(entry: string): SandboxRefusedForm {
  if (/^\*\.[A-Za-z0-9._-]+$/.test(entry)) return "pattern";
  if (entry.includes("://")) return "url";
  if (entry.includes("/")) return "path";
  if (/^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):[0-9]+$/.test(entry)) return "host-port";
  return "other";
}

/**
 * The `allowed_hosts` entries the cloud sandbox cannot enforce, as written and
 * by their form ({@link SandboxRefusedForm}), in the list's order. The sandbox
 * filters addresses: it takes out an entry's spaces, skips an empty one, and
 * holds `*` — every public address —, a host name ({@link SANDBOX_HOST_NAME}),
 * which it resolves, or an IPv6 literal, bare or in brackets. Anything else is
 * refused here, judged after the same clean-up: what the sandbox would refuse
 * at a machine's assignment, or hold as no rule at its creation. One
 * definition, read by the validator (a warning) and by the run route (a refusal
 * before any machine, on the cloud runtime).
 */
export function sandboxRefusedHosts(hosts: readonly string[]): SandboxRefusedHost[] {
  const refused: SandboxRefusedHost[] = [];
  for (const host of hosts) {
    const entry = cleaned(host);
    if (entry === "" || entry === "*" || SANDBOX_HOST_NAME.test(entry)) continue;
    if (ipv6Literal(entry) !== undefined) continue;
    refused.push({ host, form: refusedFormOf(entry) });
  }
  return refused;
}

/**
 * An entry in the form the sandbox reads it: an IPv6 literal bare — its
 * brackets, the form a URL writes it in, taken off, and its spaces with them —;
 * any other entry as written.
 */
export function sandboxHostForm(host: string): string {
  const entry = cleaned(host);
  return entry.startsWith("[") ? (ipv6Literal(entry) ?? host) : host;
}

/** What each form is, and which runtime honours it — the words of the message. */
const REFUSED_FORM_WORDS: Readonly<Record<SandboxRefusedForm, string>> = {
  pattern: "a host pattern: honoured by the local runtime only",
  "host-port": "a host with a port: honoured by no runtime",
  url: "a URL: honoured by no runtime",
  path: "a host with a path: honoured by no runtime",
  other: "not a host name the sandbox reads: honoured by no runtime",
};

/**
 * What the validator and the run route say of the entries of `hosts` the cloud
 * sandbox cannot enforce (`refused`, from {@link sandboxRefusedHosts}): each one
 * as written, with its form and which runtime honours it, then what to write
 * instead — beside `*`, which already allows every public address, nothing:
 * they are to be removed.
 */
export function sandboxRefusalMessage(
  hosts: readonly string[],
  refused: readonly SandboxRefusedHost[],
): string {
  const named = refused
    .map(({ host, form }) => `${JSON.stringify(host)} (${REFUSED_FORM_WORDS[form]})`)
    .join(", ");
  const entries = refused.length > 1 ? "entries" : "an entry";
  const head = `allowed_hosts holds ${entries} the cloud sandbox cannot enforce: ${named}.`;
  if (hosts.some((host) => cleaned(host) === "*")) {
    return `${head} "*" in the same list already allows every public address: remove ${refused.length > 1 ? "them" : "it"}.`;
  }
  const forms = new Set(refused.map(({ form }) => form));
  const advice: string[] = [];
  if (forms.has("pattern")) {
    advice.push(
      'name each host a pattern stands for (api.slack.com rather than *.slack.com), or use "*" for every public address',
    );
  }
  if (forms.has("host-port") || forms.has("url") || forms.has("path")) {
    advice.push("name a host alone — the sandbox allows a host whole, on every port");
  }
  if (forms.has("other")) {
    advice.push(
      "write a host in letters, digits, dots, hyphens and underscores — an internationalised name in its xn-- form — or as an IP address",
    );
  }
  const said = advice.join("; ");
  return `${head} ${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
}

/** The shortest timeout a run can have, in seconds: a run given `0s` ends at once. */
export const TIMEOUT_MIN_S = 1;
/**
 * The longest timeout a run can have, in seconds: the longest delay a timer
 * arms (2^31 − 1 ms), in whole seconds. Node arms a longer timer for 1 ms, and
 * the run ends at once. The runtime, which arms that timer, holds the two equal
 * in a test — this package cannot import it.
 */
export const TIMEOUT_MAX_S = 2_147_483;

/**
 * The number of seconds a `timeout` names, as written: not bounded. A run of
 * digits too long for a double reads as Infinity; a value that does not start
 * with digits, as NaN. The reading `findRefusedSettings` holds between
 * TIMEOUT_MIN_S and TIMEOUT_MAX_S.
 */
export function timeoutRawSeconds(timeout: string): number {
  return Number.parseInt(timeout, 10);
}

export const EnvironmentConfigSchema = z.object({
  networking: NetworkingConfigSchema.prefault({}),
  // No default: an agent.yaml written from the schema carries no secrets list,
  // and a list that names a secret is refused by findRefusedSettings.
  secrets: z.array(z.string()).optional(),
  // Any number of seconds, so that a version already published stays readable:
  // a value outside TIMEOUT_MIN_S to TIMEOUT_MAX_S is refused before anything is
  // published, by findRefusedSettings.
  timeout: z
    .string()
    .regex(/^\d+s$/, 'Timeout must be in seconds (e.g., "300s")')
    .default("300s"),
  max_cost: z.number().positive("max_cost must be positive").optional(),
  // `sandbox` and `filesystem` were retired: listed in RETIRED_FIELDS, so the
  // validator warns about each by name instead of letting this non-strict
  // object drop it silently.
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
