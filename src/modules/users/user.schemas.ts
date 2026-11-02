import { z } from "zod";

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    avatarUrl: z.url().nullable().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
