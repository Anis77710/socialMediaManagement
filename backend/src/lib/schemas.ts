import { z } from "zod";

export const roles = ["USER", "ADMIN"] as const;
export const platforms = [
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "X",
  "LINKEDIN",
  "TIKTOK",
  "YOUTUBE",
  "PINTEREST",
] as const;
export const postStatuses = [
  "DRAFT",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
] as const;
export const postTargetStatuses = ["PENDING", "PUBLISHED", "FAILED"] as const;

export const roleSchema = z.enum(roles);
export const platformSchema = z.enum(platforms);
export const postStatusSchema = z.enum(postStatuses);
export const postTargetStatusSchema = z.enum(postTargetStatuses);

export const idParamsSchema = z.object({
  id: z.string().min(1),
});

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.email().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  role: roleSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const publicSocialAccountSchema = z.object({
  id: z.string(),
  platform: platformSchema,
  platformAccountId: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  tokenExpiresAt: z.date().nullable(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const socialAccountSummarySchema = z.object({
  id: z.string(),
  platform: platformSchema,
  platformAccountId: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url().nullable(),
});

export const mediaSchema = z.object({
  id: z.string(),
  key: z.string(),
  url: z.url(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: z.date(),
});

export const postTargetSchema = z.object({
  id: z.string(),
  socialAccountId: z.string(),
  platformPostId: z.string().nullable(),
  status: postTargetStatusSchema,
  error: z.string().nullable(),
  publishedAt: z.date().nullable(),
  socialAccount: socialAccountSummarySchema,
});

export const postSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: postStatusSchema,
  scheduledAt: z.date().nullable(),
  publishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  media: z.array(mediaSchema),
  targets: z.array(postTargetSchema),
});

export const paginationMetaSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});
