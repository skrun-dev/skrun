/**
 * Test helper: a throwaway profile for the CLI, and a sign-in file written in it.
 *
 * Not part of the build (`tsconfig.json` leaves out `*.shared.ts`), never
 * imported by the CLI itself — only by tests.
 *
 * `useThrowawayProfile()` points HOME and USERPROFILE (what `homedir()` reads
 * on Windows) to a new temporary directory for the current test, and removes it
 * when the test ends. It refuses to go on unless `homedir()` returns that
 * directory, so a test never reads or writes the sign-in file of the machine
 * running it. It also clears SKRUN_REGISTRY_URL: the server a command targets
 * comes from the test alone, never from the shell that runs it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";

export interface ThrowawayProfile {
  /** The home directory the CLI sees. */
  readonly home: string;
  /** The CLI's directory in it. */
  readonly dir: string;
  /** The sign-in file's path. */
  readonly file: string;
}

export function useThrowawayProfile(): ThrowawayProfile {
  const home = mkdtempSync(join(tmpdir(), "skrun-cli-profile-"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("SKRUN_REGISTRY_URL", undefined);
  if (homedir() !== home) {
    throw new Error(
      "homedir() does not follow the throwaway profile: the test would touch a real one",
    );
  }
  const dir = join(home, ".skrun");
  return { home, dir, file: join(dir, "config.json") };
}

/** Write the sign-in file as given: a text as it is, anything else as JSON. */
export function writeSignInFile(profile: ThrowawayProfile, content: unknown): void {
  mkdirSync(profile.dir, { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(profile.file, text);
}

/**
 * Write a sign-in file of this CLI holding one session — the current one
 * unless `current` is false.
 */
export function writeSession(
  profile: ThrowawayProfile,
  session: { address: string; token: string; username?: string; current?: boolean },
): void {
  const { address, token, username, current = true } = session;
  writeSignInFile(profile, {
    version: 2,
    ...(current ? { current: address } : {}),
    sessions: { [address]: username === undefined ? { token } : { token, username } },
  });
}
