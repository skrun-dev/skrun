import { z } from "zod";

export const MEDIA_TYPES = ["image", "document", "audio"] as const;
export type Media = (typeof MEDIA_TYPES)[number];

export const DEFAULT_MAX_SIZE: Record<Media, number> = {
  image: 5_000_000,
  document: 25_000_000,
  audio: 25_000_000,
};

export const DEFAULT_MIME_TYPES: Record<Media, readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp", "image/heic"],
  document: ["application/pdf"],
  audio: ["audio/wav", "audio/mp3", "audio/mp4", "audio/m4a", "audio/webm"],
};

export const FileInputFieldSchema = z.object({
  name: z.string().min(1, "Input name is required"),
  type: z.literal("file"),
  media: z.enum(MEDIA_TYPES),
  mime_types: z.array(z.string().min(1)).optional(),
  max_size: z.number().int().positive().optional(),
  max_count: z.number().int().positive().default(1),
  required: z.boolean().default(true),
  description: z.string().optional(),
});

export type FileInputField = z.infer<typeof FileInputFieldSchema>;

// ============================================================================
// Wire format — the 3 transport sources for a file input on POST /run
// ============================================================================

export const WireFileSourceSchema = z.discriminatedUnion("source", [
  z.object({
    type: z.literal("file"),
    source: z.literal("id"),
    file_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("file"),
    source: z.literal("data"),
    media_type: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({
    type: z.literal("file"),
    source: z.literal("url"),
    url: z.string().url(),
  }),
]);

export type WireFileSource = z.infer<typeof WireFileSourceSchema>;

export function resolveFileInputDefaults(field: FileInputField): {
  mime_types: string[];
  max_size: number;
} {
  return {
    mime_types: field.mime_types ?? [...DEFAULT_MIME_TYPES[field.media]],
    max_size: field.max_size ?? DEFAULT_MAX_SIZE[field.media],
  };
}
