import { randomBytes } from "node:crypto";
import type { Platform, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { encryptToken, decryptToken } from "../../lib/crypto.js";
import { toJson } from "../../lib/json.js";
import type { SocialPublishers } from "../../providers/social/index.js";

export type ConnectionService = ReturnType<typeof createConnectionService>;

const STATE_TTL_MS = 10 * 60 * 1000;

export function createConnectionService(deps: {
  prisma: PrismaClient;
  publishers: SocialPublishers;
  publicApiUrl: string;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function accountLimit(businessId: string): Promise<number> {
    const subscription = await deps.prisma.subscription.findUnique({
      where: { businessId },
      include: { plan: true },
    });
    const limits = subscription?.limitsSnapshot as { accounts?: number } | null;

    return limits?.accounts ?? subscription?.plan.maxAccounts ?? 1;
  }

  async function list(businessId: string) {
    const accounts = await deps.prisma.socialAccount.findMany({
      where: { businessId, status: { not: "REVOKED" } },
      orderBy: { createdAt: "asc" },
    });

    return accounts.map(toView);
  }

  function toView(account: {
    id: string;
    platform: Platform;
    externalId: string;
    displayName: string;
    username: string | null;
    avatarUrl: string | null;
    tokenExpiresAt: Date | null;
    scopes: string[];
    status: string;
    lastCheckedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: account.id,
      platform: account.platform,
      externalId: account.externalId,
      displayName: account.displayName,
      username: account.username,
      avatarUrl: account.avatarUrl,
      tokenExpiresAt: account.tokenExpiresAt,
      scopes: account.scopes,
      status: account.status,
      lastCheckedAt: account.lastCheckedAt,
      lastError: account.lastError,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  async function startOAuth(input: {
    businessId: string;
    userId: string;
    platform: Platform;
    returnTo: string;
  }) {
    const activeCount = await deps.prisma.socialAccount.count({
      where: { businessId: input.businessId, status: "ACTIVE" },
    });
    const limit = await accountLimit(input.businessId);

    if (activeCount >= limit) {
      throw new AppError(402, "ACCOUNT_LIMIT_REACHED", "Your plan's connected account limit is reached", {
        limit,
        upgradeOptions: ["basic", "standard", "premium"],
      });
    }

    const state = randomBytes(24).toString("base64url");
    await deps.prisma.oAuthState.create({
      data: {
        state,
        businessId: input.businessId,
        userId: input.userId,
        platform: input.platform,
        returnTo: input.returnTo,
        expiresAt: new Date(now().getTime() + STATE_TTL_MS),
      },
    });
    const publisher = deps.publishers[input.platform];
    const { url } = await publisher.beginOAuth({
      businessId: input.businessId,
      userId: input.userId,
      platform: input.platform,
      state,
      returnTo: input.returnTo,
    });

    return { url, state };
  }

  async function completeOAuth(input: { platform: Platform; code: string; state: string }) {
    const saved = await deps.prisma.oAuthState.findUnique({ where: { state: input.state } });

    if (!saved || saved.platform !== input.platform || saved.expiresAt <= now()) {
      throw new AppError(400, "INVALID_OAUTH_STATE", "The connection request has expired or is invalid");
    }

    await deps.prisma.oAuthState.delete({ where: { state: input.state } });
    const publisher = deps.publishers[input.platform];
    const discovered = await publisher.completeOAuth({
      code: input.code,
      state: input.state,
      redirectUri: `${deps.publicApiUrl.replace(/\/$/, "")}/v1/public/oauth/${input.platform.toLowerCase()}/callback`,
    });
    const savedAccounts = [];

    for (const account of discovered) {
      const record = await deps.prisma.socialAccount.upsert({
        where: {
          businessId_platform_externalId: {
            businessId: saved.businessId,
            platform: account.platform,
            externalId: account.externalId,
          },
        },
        create: {
          businessId: saved.businessId,
          platform: account.platform,
          externalId: account.externalId,
          displayName: account.displayName,
          username: account.username ?? null,
          avatarUrl: account.avatarUrl ?? null,
          accessTokenEnc: encryptToken(account.accessToken),
          refreshTokenEnc: account.refreshToken ? encryptToken(account.refreshToken) : null,
          userTokenEnc: account.userToken ? encryptToken(account.userToken) : null,
          tokenExpiresAt: account.tokenExpiresAt ?? null,
          scopes: account.scopes,
          status: "ACTIVE",
          meta: toJson(account.meta ?? {}),
          connectedById: saved.userId,
          lastCheckedAt: now(),
        },
        update: {
          displayName: account.displayName,
          username: account.username ?? null,
          avatarUrl: account.avatarUrl ?? null,
          accessTokenEnc: encryptToken(account.accessToken),
          refreshTokenEnc: account.refreshToken ? encryptToken(account.refreshToken) : null,
          userTokenEnc: account.userToken ? encryptToken(account.userToken) : null,
          tokenExpiresAt: account.tokenExpiresAt ?? null,
          scopes: account.scopes,
          status: "ACTIVE",
          meta: toJson(account.meta ?? {}),
          lastCheckedAt: now(),
          revokedAt: null,
          lastError: null,
        },
      });
      savedAccounts.push(record);
    }

    const activeCount = await deps.prisma.socialAccount.count({
      where: { businessId: saved.businessId, status: "ACTIVE" },
    });

    if (activeCount > 0) {
      const business = await deps.prisma.business.findUnique({
        where: { id: saved.businessId },
        select: { onboardingStep: true },
      });

      if (business?.onboardingStep === "CONNECT") {
        await deps.prisma.business.update({
          where: { id: saved.businessId },
          data: { onboardingStep: "FIRST_POSTER" },
        });
      }
    }

    return { accounts: savedAccounts.map(toView), returnTo: saved.returnTo };
  }

  async function disconnect(businessId: string, accountId: string) {
    const account = await deps.prisma.socialAccount.findFirst({
      where: { id: accountId, businessId },
    });

    if (!account) {
      throw AppError.notFound("Connected account not found");
    }

    const publisher = deps.publishers[account.platform];

    try {
      await publisher.revoke({
        accessToken: decryptToken(account.accessTokenEnc),
        externalId: account.externalId,
      });
    } catch {
      // Best effort; local disconnect must still succeed.
    }

    await deps.prisma.socialAccount.update({
      where: { id: account.id },
      data: { status: "REVOKED", revokedAt: now() },
    });

    return { ok: true };
  }

  async function refreshExpiring(withinDays = 7): Promise<number> {
    const accounts = await deps.prisma.socialAccount.findMany({
      where: {
        status: "ACTIVE",
        tokenExpiresAt: { not: null, lte: new Date(now().getTime() + withinDays * 86_400_000) },
      },
    });
    let refreshed = 0;

    for (const account of accounts) {
      try {
        const result = await deps.publishers[account.platform].refresh({
          accessToken: decryptToken(account.accessTokenEnc),
          refreshToken: account.refreshTokenEnc ? decryptToken(account.refreshTokenEnc) : null,
          userToken: account.userTokenEnc ? decryptToken(account.userTokenEnc) : null,
        });
        await deps.prisma.socialAccount.update({
          where: { id: account.id },
          data: {
            accessTokenEnc: encryptToken(result.accessToken),
            refreshTokenEnc: result.refreshToken ? encryptToken(result.refreshToken) : null,
            tokenExpiresAt: result.expiresAt,
            lastCheckedAt: now(),
            lastError: null,
          },
        });
        refreshed += 1;
      } catch (error) {
        await deps.prisma.socialAccount.update({
          where: { id: account.id },
          data: {
            status: "NEEDS_REAUTH",
            lastCheckedAt: now(),
            lastError: error instanceof Error ? error.message.slice(0, 500) : "Token refresh failed",
          },
        });
      }
    }

    return refreshed;
  }

  async function getDecrypted(accountId: string) {
    const account = await deps.prisma.socialAccount.findUnique({ where: { id: accountId } });

    if (!account) {
      throw AppError.notFound("Connected account not found");
    }

    return {
      ...account,
      accessToken: decryptToken(account.accessTokenEnc),
    };
  }

  return { list, startOAuth, completeOAuth, disconnect, refreshExpiring, getDecrypted, toView };
}
