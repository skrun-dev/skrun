import { closeSync, fstatSync, writeSync } from "node:fs";
import { Socket } from "node:net";

/**
 * One-shot channel to the privileged egress helper.
 *
 * WHY THIS EXISTS
 * The agent's allowed-host rules are real firewall rules, installed as root by the
 * entrypoint before it drops this process to an unprivileged user with no
 * capabilities. A pre-created machine does not know its agent at boot, so the rules
 * have to be installed later — at which point this process can no longer install
 * them itself. A privileged helper stays alive for exactly that, and this module is
 * the one-message channel to it.
 *
 * WHAT KEEPS AGENT CODE OUT OF IT
 * Agent scripts are spawned by this very process and run under the SAME user, so
 * nothing here can rely on a secret or on file permissions alone. Three independent
 * things hold instead, all verified on the real image before this was written:
 *
 *   1. Node does not hand non-standard descriptors to spawned children. A child of
 *      `execFile` sees only its own standard streams — before AND after we close
 *      ours. This is the load-bearing one.
 *   2. We close both descriptors synchronously at the end of the exchange, which
 *      happens before any agent code can possibly run (the assignment call strictly
 *      precedes initialisation, which precedes the first tool dispatch).
 *   3. The descriptors' filesystem rendezvous lives in a directory only the
 *      privileged user can traverse, so agent code cannot reach it by path either —
 *      not even while the exchange is in flight.
 *
 * Deliberately NOT used: marking the descriptors close-on-exec. Node exposes no
 * `fcntl`, so it would need a native addon — a compiled dependency in the sandbox
 * image for a guarantee (1) already provides.
 *
 * Zero dependencies by design: this file must not grow an import surface.
 */

/** Descriptors the entrypoint hands over across the privilege drop. */
const REQUEST_FD = 3;
const ACK_FD = 4;

/** The helper answers with exactly one line: this, or anything else meaning failure. */
const ACK_OK = "OK";

/**
 * Whether this process was started as a pre-created machine awaiting assignment.
 *
 * Captured ONCE at module load, before anything else in this program can open a
 * descriptor — otherwise a descriptor opened later could occupy the same number and
 * be mistaken for the channel. Both must be pipes: an ordinary file or socket at
 * those numbers is not our channel.
 */
const CHANNEL_PRESENT = ((): boolean => {
  try {
    return fstatSync(REQUEST_FD).isFIFO() && fstatSync(ACK_FD).isFIFO();
  } catch {
    // No such descriptor — an ordinary machine, created for a single run.
    return false;
  }
})();

export function isPoolMode(): boolean {
  return CHANNEL_PRESENT;
}

export class EgressChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressChannelError";
  }
}

let used = false;

/**
 * Hand the agent's allowed hosts to the privileged helper and wait for it to confirm
 * the rules are in place.
 *
 * Fails closed by design: a timeout, a refusal, or a closed channel throws, and the
 * caller must NOT proceed to install the run credential. A run that started with its
 * egress rules unconfirmed would be a sandbox without a sandbox — the same property
 * the boot-time path already has, where a failed firewall setup aborts the boot
 * outright.
 *
 * Single-use: the channel carries one message for the machine's whole life. A second
 * call is a programming error, not a retry.
 */
export async function applyEgress(hosts: string[], timeoutMs: number): Promise<void> {
  if (!CHANNEL_PRESENT) {
    throw new EgressChannelError("no egress channel on this machine (not a pre-created runner)");
  }
  if (used) {
    throw new EgressChannelError("egress channel already used — it carries exactly one message");
  }
  used = true;

  // Reject anything that would corrupt the line-oriented framing before it reaches a
  // process running as root. The helper re-validates, but a malformed message should
  // never leave here in the first place.
  for (const host of hosts) {
    if (/[\n\r,]/.test(host)) {
      throw new EgressChannelError(`invalid host in egress request: ${JSON.stringify(host)}`);
    }
  }

  const ack = new Socket({ fd: ACK_FD, readable: true, writable: false });
  try {
    writeSync(REQUEST_FD, `${hosts.join(",")}\n`);
    const reply = await readOneLine(ack, timeoutMs);
    if (reply !== ACK_OK) {
      throw new EgressChannelError(
        `egress helper did not confirm the rules (replied ${JSON.stringify(reply)})`,
      );
    }
  } finally {
    // Close both ends whatever happened. On the failure path the machine is already
    // unusable — the caller will not install the run credential — but leaving a
    // descriptor open would keep a channel alive for the rest of the process's life.
    ack.destroy(); // owns ACK_FD
    try {
      closeSync(REQUEST_FD);
    } catch {
      // Already closed — nothing to do.
    }
  }
}

function readOneLine(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(() =>
        reject(new EgressChannelError(`egress helper did not answer within ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      action();
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) finish(() => resolve(buffer.slice(0, newline).trim()));
    });
    socket.on("error", (err) =>
      finish(() => reject(new EgressChannelError(`egress channel error: ${err.message}`))),
    );
    socket.on("end", () =>
      finish(() => reject(new EgressChannelError("egress channel closed before an answer"))),
    );
  });
}
