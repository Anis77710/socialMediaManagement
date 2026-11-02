import { z } from "zod";
import { paginationQuerySchema } from "../../lib/pagination.js";
import { postStatusSchema } from "../../lib/schemas.js";

const socialAccountIdsSchema = z.array(z.string().min(1)).max(20);
const mediaIdsSchema = z.array(z.string().min(1)).max(10);

export const listPostsQuerySchema = paginationQuerySchema.extend({
  status: postStatusSchema.optional(),
  socialAccountId: z.string().min(1).optional(),
});

export const createPostSchema = z.object({
  content: z.string().trim().min(1).max(5000),
  scheduledAt: z.coerce.date().optional(),
  socialAccountIds: socialAccountIdsSchema.default([]),
  mediaIds: mediaIdsSchema.default([]),
});

export const updatePostSchema = z
  .object({
    content: z.string().trim().min(1).max(5000).optional(),
    scheduledAt: z.coerce.date().nullable().optional(),
    socialAccountIds: socialAccountIdsSchema.optional(),
    mediaIds: mediaIdsSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one field must be provided",
  });

export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;
export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
