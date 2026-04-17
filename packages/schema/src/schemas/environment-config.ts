import { z } from "zod";

export const NetworkingConfigSchema = z.object({
  allowed_hosts: z.array(z.string()).default([]),
});

export type NetworkingConfig = z.infer<typeof NetworkingConfigSchema>;

export const EnvironmentConfigSchema = z.object({
  networking: NetworkingConfigSchema.default({}),
  filesystem: z.enum(["none", "read-only", "read-write"]).default("read-only"),
  secrets: z.array(z.string()).default([]),
  timeout: z
    .string()
    .regex(/^\d+s$/, 'Timeout must be in seconds (e.g., "300s")')
    .default("300s"),
  max_cost: z.number().positive("max_cost must be positive").optional(),
  sandbox: z.enum(["strict", "permissive"]).default("strict"),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
