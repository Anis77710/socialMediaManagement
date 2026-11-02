import type { FastifyInstance } from "fastify";
import type { Prisma } from "../../generated/prisma/client.js";
import { encryptToken } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import type { PublicSocialAccount } from "../../lib/selects.js";
import { publicSocialAccountSelect } from "../../lib/selects.js";
import type {
  CreateSocialAccountInput,
  ListSocialAccountsQuery,
  UpdateSocialAccountInput,
} from "./social-account.schemas.js";

export async function listSocialAccounts(
  app: FastifyInstance,
  userId: string,
  query: ListSocialAccountsQuery,
): Promise<PublicSocialAccount[]> {
  return app.prisma.socialAccount.findMany({
    where: {
      userId,
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    },
    select: publicSocialAccountSelect,
    orderBy: [{ platform: "asc" }, { username: "asc" }],
  });
}

export async function getSocialAccount(
  app: FastifyInstance,
  userId: string,
  socialAccountId: string,
): Promise<PublicSocialAccount> {
  const socialAccount = await app.prisma.socialAccount.findFirst({
    where: {
      id: socialAccountId,
      userId,
    },
    select: publicSocialAccountSelect,
  });

  if (!socialAccount) {
    throw AppError.notFound("Social account not found");
  }

  return socialAccount;
}

export async function createSocialAccount(
  app: FastifyInstance,
  userId: string,
  input: CreateSocialAccountInput,
): Promise<PublicSocialAccount> {
  return app.prisma.socialAccount.create({
    data: {
      userId,
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      username: input.username,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      accessToken: encryptToken(input.accessToken),
      refreshToken: input.refreshToken ? encryptToken(input.refreshToken) : null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      isActive: input.isActive ?? true,
    },
    select: publicSocialAccountSelect,
  });
}

export async function updateSocialAccount(
  app: FastifyInstance,
  userId: string,
  socialAccountId: string,
  input: UpdateSocialAccountInput,
): Promise<PublicSocialAccount> {
  const existing = await app.prisma.socialAccount.findFirst({
    where: {
      id: socialAccountId,
      userId,
    },
    select: { id: true },
  });

  if (!existing) {
    throw AppError.notFound("Social account not found");
  }

  const data: Prisma.SocialAccountUpdateInput = {};

  if (input.username !== undefined) {
    data.username = input.username;
  }

  if (input.displayName !== undefined) {
    data.displayName = input.displayName;
  }

  if (input.avatarUrl !== undefined) {
    data.avatarUrl = input.avatarUrl;
  }

  if (input.accessToken !== undefined) {
    data.accessToken = encryptToken(input.accessToken);
  }

  if (input.refreshToken !== undefined) {
    data.refreshToken = input.refreshToken === null ? null : encryptToken(input.refreshToken);
  }

  if (input.tokenExpiresAt !== undefined) {
    data.tokenExpiresAt = input.tokenExpiresAt;
  }

  if (input.isActive !== undefined) {
    data.isActive = input.isActive;
  }

  return app.prisma.socialAccount.update({
    where: { id: socialAccountId },
    data,
    select: publicSocialAccountSelect,
  });
}

export async function deleteSocialAccount(
  app: FastifyInstance,
  userId: string,
  socialAccountId: string,
): Promise<void> {
  const result = await app.prisma.socialAccount.deleteMany({
    where: {
      id: socialAccountId,
      userId,
    },
  });

  if (result.count === 0) {
    throw AppError.notFound("Social account not found");
  }
}
