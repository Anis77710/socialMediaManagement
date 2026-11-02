import { z } from "zod";
import { platformSchema } from "../../lib/schemas.js";

const booleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");

export const listSocialAccountsQuerySchema = z.object({
  platform: platformSchema.optional(),
  isActive: booleanQuerySchema.optional(),
});

export const createSocialAccountSchema = z.object({
  platform: platformSchema,
  platformAccountId: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  avatarUrl: z.url().nullable().optional(),
  accessToken: z.string().min(1).max(4096),
  refreshToken: z.string().min(1).max(4096).nullable().optional(),
  tokenExpiresAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateSocialAccountSchema = z
  .object({
    username: z.string().trim().min(1).max(100).optional(),
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    avatarUrl: z.url().nullable().optional(),
    accessToken: z.string().min(1).max(4096).optional(),
    refreshToken: z.string().min(1).max(4096).nullable().optional(),
    tokenExpiresAt: z.coerce.date().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one field must be provided",
  });

export type ListSocialAccountsQuery = z.infer<typeof listSocialAccountsQuerySchema>;
export type CreateSocialAccountInput = z.infer<typeof createSocialAccountSchema>;
export type UpdateSocialAccountInput = z.infer<typeof updateSocialAccountSchema>;
