import { z } from "zod";

const LLM_PROVIDERS = ["anthropic", "openai", "google", "mistral", "groq", "xai", "meta"] as const;

export const ModelProviderSchema = z.enum(LLM_PROVIDERS);

export const FallbackModelSchema = z.object({
  provider: ModelProviderSchema,
  name: z.string().min(1, "Fallback model name is required"),
});

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  name: z.string().min(1, "Model name is required"),
  temperature: z.number().min(0).max(2).optional(),
  base_url: z.string().url("base_url must be a valid URL").optional(),
  fallback: FallbackModelSchema.optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
