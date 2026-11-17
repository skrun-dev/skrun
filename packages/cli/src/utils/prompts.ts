import * as p from "@clack/prompts";
import { MODEL_CHOICES } from "@skrun-dev/schema";

function handleCancel(value: unknown): asserts value is string {
  if (p.isCancel(value)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
}

export async function askText(message: string, defaultValue?: string): Promise<string> {
  const value = await p.text({
    message,
    placeholder: defaultValue,
    defaultValue,
  });
  handleCancel(value);
  return value;
}

/**
 * Whether a prompt can be answered: the standard input is a terminal. A
 * script, a CI job or a pipe gives none — a prompt there waits for an answer
 * that never comes.
 */
export function canPrompt(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Ask for a text; undefined when the user cancels it (Ctrl+C). Unlike
 * `askText`, a cancel does not end the process: the caller says what it means.
 */
export async function askTextOrCancel(
  message: string,
  defaultValue?: string,
): Promise<string | undefined> {
  const value = await p.text({
    message,
    placeholder: defaultValue,
    defaultValue,
  });
  return p.isCancel(value) ? undefined : value;
}

export async function askSelect(
  message: string,
  options: { value: string; label: string }[],
): Promise<string> {
  const value = await p.select({ message, options });
  handleCancel(value);
  return value as string;
}

export async function askModel(): Promise<{ provider: string; name: string }> {
  const selected = await askSelect(
    "Model provider and name?",
    MODEL_CHOICES.map((c) => ({ value: `${c.provider}/${c.name}`, label: c.label })),
  );
  // Split at the first "/" only: a model name can itself contain one
  // (`groq/openai/gpt-oss-120b`), as `skrun init --model` already allows.
  const slash = selected.indexOf("/");
  return { provider: selected.slice(0, slash), name: selected.slice(slash + 1) };
}

export async function askConfirm(message: string): Promise<boolean> {
  const value = await p.confirm({ message });
  handleCancel(value);
  return value as boolean;
}
