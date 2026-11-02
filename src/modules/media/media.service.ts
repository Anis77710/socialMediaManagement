import type { FastifyInstance } from "fastify";
import { AppError } from "../../lib/errors.js";
import { createPaginationMeta } from "../../lib/pagination.js";
import type { PaginationMeta, PaginationQuery } from "../../lib/pagination.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { mediaSelect } from "../../lib/selects.js";
import type { CreateMediaInput } from "./media.schemas.js";

type MediaItem = Prisma.MediaGetPayload<{ select: typeof mediaSelect }>;

export async function listMedia(
  app: FastifyInstance,
  userId: string,
  query: PaginationQuery,
): Promise<{ media: MediaItem[]; meta: PaginationMeta }> {
  const where: Prisma.MediaWhereInput = { userId };

  const [media, total] = await app.prisma.$transaction([
    app.prisma.media.findMany({
      where,
      select: mediaSelect,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    app.prisma.media.count({ where }),
  ]);

  return {
    media,
    meta: createPaginationMeta(total, query.page, query.limit),
  };
}

export async function getMedia(
  app: FastifyInstance,
  userId: string,
  mediaId: string,
): Promise<MediaItem> {
  const media = await app.prisma.media.findFirst({
    where: {
      id: mediaId,
      userId,
    },
    select: mediaSelect,
  });

  if (!media) {
    throw AppError.notFound("Media not found");
  }

  return media;
}

export async function createMedia(
  app: FastifyInstance,
  userId: string,
  input: CreateMediaInput,
): Promise<MediaItem> {
  return app.prisma.media.create({
    data: {
      userId,
      key: input.key,
      url: input.url,
      mimeType: input.mimeType,
      size: input.size,
      width: input.width ?? null,
      height: input.height ?? null,
    },
    select: mediaSelect,
  });
}

export async function deleteMedia(
  app: FastifyInstance,
  userId: string,
  mediaId: string,
): Promise<void> {
  const result = await app.prisma.media.deleteMany({
    where: {
      id: mediaId,
      userId,
    },
  });

  if (result.count === 0) {
    throw AppError.notFound("Media not found");
  }
}
