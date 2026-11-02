import type { FastifyInstance } from "fastify";
import { PostStatus, type Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { createPaginationMeta } from "../../lib/pagination.js";
import type { PaginationMeta } from "../../lib/pagination.js";
import type { PostWithRelations } from "../../lib/selects.js";
import { postInclude } from "../../lib/selects.js";
import type { CreatePostInput, ListPostsQuery, UpdatePostInput } from "./post.schemas.js";

const editableStatuses = new Set<PostStatus>([
  PostStatus.DRAFT,
  PostStatus.SCHEDULED,
  PostStatus.CANCELLED,
]);

async function validateSocialAccountIds(
  app: FastifyInstance,
  userId: string,
  socialAccountIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(socialAccountIds)];

  if (uniqueIds.length === 0) {
    return uniqueIds;
  }

  const accounts = await app.prisma.socialAccount.findMany({
    where: {
      id: { in: uniqueIds },
      userId,
    },
    select: { id: true },
  });

  if (accounts.length !== uniqueIds.length) {
    const foundIds = new Set(accounts.map((account) => account.id));
    throw AppError.badRequest("One or more social accounts are invalid", {
      socialAccountIds: uniqueIds.filter((id) => !foundIds.has(id)),
    });
  }

  return uniqueIds;
}

async function validateMediaIds(
  app: FastifyInstance,
  userId: string,
  mediaIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(mediaIds)];

  if (uniqueIds.length === 0) {
    return uniqueIds;
  }

  const media = await app.prisma.media.findMany({
    where: {
      id: { in: uniqueIds },
      userId,
    },
    select: { id: true },
  });

  if (media.length !== uniqueIds.length) {
    const foundIds = new Set(media.map((item) => item.id));
    throw AppError.badRequest("One or more media items are invalid", {
      mediaIds: uniqueIds.filter((id) => !foundIds.has(id)),
    });
  }

  return uniqueIds;
}

function assertScheduledAtIsFuture(scheduledAt: Date): void {
  if (scheduledAt <= new Date()) {
    throw AppError.badRequest("scheduledAt must be in the future");
  }
}

export async function listPosts(
  app: FastifyInstance,
  userId: string,
  query: ListPostsQuery,
): Promise<{ posts: PostWithRelations[]; meta: PaginationMeta }> {
  const where: Prisma.PostWhereInput = {
    userId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.socialAccountId
      ? { targets: { some: { socialAccountId: query.socialAccountId } } }
      : {}),
  };

  const [posts, total] = await app.prisma.$transaction([
    app.prisma.post.findMany({
      where,
      include: postInclude,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    app.prisma.post.count({ where }),
  ]);

  return {
    posts,
    meta: createPaginationMeta(total, query.page, query.limit),
  };
}

export async function getPost(
  app: FastifyInstance,
  userId: string,
  postId: string,
): Promise<PostWithRelations> {
  const post = await app.prisma.post.findFirst({
    where: {
      id: postId,
      userId,
    },
    include: postInclude,
  });

  if (!post) {
    throw AppError.notFound("Post not found");
  }

  return post;
}

export async function createPost(
  app: FastifyInstance,
  userId: string,
  input: CreatePostInput,
): Promise<PostWithRelations> {
  if (input.scheduledAt) {
    assertScheduledAtIsFuture(input.scheduledAt);
  }

  const [socialAccountIds, mediaIds] = await Promise.all([
    validateSocialAccountIds(app, userId, input.socialAccountIds),
    validateMediaIds(app, userId, input.mediaIds),
  ]);

  return app.prisma.post.create({
    data: {
      userId,
      content: input.content,
      scheduledAt: input.scheduledAt ?? null,
      status: input.scheduledAt ? PostStatus.SCHEDULED : PostStatus.DRAFT,
      ...(socialAccountIds.length > 0
        ? {
            targets: {
              create: socialAccountIds.map((socialAccountId) => ({ socialAccountId })),
            },
          }
        : {}),
      ...(mediaIds.length > 0
        ? {
            media: {
              connect: mediaIds.map((id) => ({ id })),
            },
          }
        : {}),
    },
    include: postInclude,
  });
}

export async function updatePost(
  app: FastifyInstance,
  userId: string,
  postId: string,
  input: UpdatePostInput,
): Promise<PostWithRelations> {
  const existing = await app.prisma.post.findFirst({
    where: {
      id: postId,
      userId,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!existing) {
    throw AppError.notFound("Post not found");
  }

  if (!editableStatuses.has(existing.status)) {
    throw AppError.conflict("Published or in-progress posts cannot be edited");
  }

  const data: Prisma.PostUpdateInput = {};

  if (input.content !== undefined) {
    data.content = input.content;
  }

  if (input.scheduledAt !== undefined) {
    if (input.scheduledAt === null) {
      data.scheduledAt = null;
      data.status = PostStatus.DRAFT;
    } else {
      assertScheduledAtIsFuture(input.scheduledAt);
      data.scheduledAt = input.scheduledAt;
      data.status = PostStatus.SCHEDULED;
    }
  }

  if (input.socialAccountIds !== undefined) {
    const socialAccountIds = await validateSocialAccountIds(app, userId, input.socialAccountIds);
    data.targets = {
      deleteMany: {},
      create: socialAccountIds.map((socialAccountId) => ({ socialAccountId })),
    };
  }

  if (input.mediaIds !== undefined) {
    const mediaIds = await validateMediaIds(app, userId, input.mediaIds);
    data.media = {
      set: mediaIds.map((id) => ({ id })),
    };
  }

  return app.prisma.post.update({
    where: { id: postId },
    data,
    include: postInclude,
  });
}

export async function deletePost(
  app: FastifyInstance,
  userId: string,
  postId: string,
): Promise<void> {
  const result = await app.prisma.post.deleteMany({
    where: {
      id: postId,
      userId,
    },
  });

  if (result.count === 0) {
    throw AppError.notFound("Post not found");
  }
}
