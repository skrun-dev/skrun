import { z } from "zod";
import { FileInputFieldSchema } from "./file-input.js";

const PRIMITIVE_FIELD_TYPES = ["string", "number", "boolean", "object", "array"] as const;

export const PrimitiveInputFieldSchema = z.object({
  name: z.string().min(1, "Input name is required"),
  type: z.enum(PRIMITIVE_FIELD_TYPES),
  required: z.boolean().default(true),
  description: z.string().optional(),
  default: z.unknown().optional(),
});

export const InputFieldSchema = z.discriminatedUnion("type", [
  PrimitiveInputFieldSchema,
  FileInputFieldSchema,
]);

export const OutputFieldSchema = z.object({
  name: z.string().min(1, "Output name is required"),
  type: z.enum(PRIMITIVE_FIELD_TYPES),
  description: z.string().optional(),
});

export type PrimitiveInputField = z.infer<typeof PrimitiveInputFieldSchema>;
export type InputField = z.infer<typeof InputFieldSchema>;
export type OutputField = z.infer<typeof OutputFieldSchema>;
