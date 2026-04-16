import { z } from "zod";

const TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export const InputSchemaSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).default({}),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

export const ToolConfigSchema = z.object({
  name: z
    .string()
    .min(1, "Tool name is required")
    .regex(
      TOOL_NAME_REGEX,
      "Tool name must match /^[a-zA-Z_][a-zA-Z0-9_-]*$/ (letters, digits, _ and - allowed)",
    ),
  description: z.string().min(1, "Tool description is required"),
  input_schema: InputSchemaSchema,
});

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type InputSchema = z.infer<typeof InputSchemaSchema>;
