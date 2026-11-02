import type { Prisma } from "../generated/prisma/client.js";

export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;

export const publicSocialAccountSelect = {
  id: true,
  platform: true,
  platformAccountId: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  tokenExpiresAt: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SocialAccountSelect;

export type PublicSocialAccount = Prisma.SocialAccountGetPayload<{
  select: typeof publicSocialAccountSelect;
}>;

export const mediaSelect = {
  id: true,
  key: true,
  url: true,
  mimeType: true,
  size: true,
  width: true,
  height: true,
  createdAt: true,
} satisfies Prisma.MediaSelect;

export const socialAccountSummarySelect = {
  id: true,
  platform: true,
  platformAccountId: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} satisfies Prisma.SocialAccountSelect;

export const postTargetSelect = {
  id: true,
  socialAccountId: true,
  platformPostId: true,
  status: true,
  error: true,
  publishedAt: true,
  socialAccount: {
    select: socialAccountSummarySelect,
  },
} satisfies Prisma.PostTargetSelect;

export const postInclude = {
  media: {
    select: mediaSelect,
  },
  targets: {
    select: postTargetSelect,
    orderBy: {
      createdAt: "asc",
    },
  },
} satisfies Prisma.PostInclude;

export type PostWithRelations = Prisma.PostGetPayload<{
  include: typeof postInclude;
}>;
