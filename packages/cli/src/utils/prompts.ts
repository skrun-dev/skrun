import * as p from "@clack/prompts";

export const DEFAULT_MODELS_BY_PROVIDER = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  google: "gemini-2.5-flash",
  mistral: "mistral-large-latest",
  groq: "llama-3.3-70b-versatile",
} as const;

const MODEL_OPTIONS = [
  { value: "anthropic/claude-sonnet-4-20250514", label: "Anthropic - claude-sonnet-4" },
  { value: "openai/gpt-4o", label: "OpenAI - gpt-4o" },
  { value: "google/gemini-2.5-flash", label: "Google - gemini-2.5-flash" },
  { value: "mistral/mistral-large-latest", label: "Mistral - mistral-large" },
  { value: "groq/llama-3.3-70b-versatile", label: "Groq - llama-3.3-70b" },
] as const;

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

export async function askSelect(
  message: string,
  options: { value: string; label: string }[],
): Promise<string> {
  const value = await p.select({ message, options });
  handleCancel(value);
  return value as string;
}

export async function askModel(): Promise<{ provider: string; name: string }> {
  const selected = await askSelect("Model provider and name?", [...MODEL_OPTIONS]);
  const [provider, name] = selected.split("/");
  return { provider, name };
}

export async function askConfirm(message: string): Promise<boolean> {
  const value = await p.confirm({ message });
  handleCancel(value);
  return value as boolean;
}
