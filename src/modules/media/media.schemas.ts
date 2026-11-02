import { z } from "zod";

export const createMediaSchema = z.object({
  key: z.string().trim().min(1).max(500),
  url: z.url(),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export type CreateMediaInput = z.infer<typeof createMediaSchema>;
