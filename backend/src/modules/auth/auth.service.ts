import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { hashToken } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import type { PublicUser } from "../../lib/selects.js";
import { publicUserSelect } from "../../lib/selects.js";
import type { LoginInput, RefreshTokenInput, RegisterInput } from "./auth.schemas.js";

const refreshTokenTtlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: string;
};

function toPublicUser(
  user: PublicUser & {
    passwordHash: string;
  },
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function createTokenPair(app: FastifyInstance, userId: string): Promise<TokenPair> {
  const refreshToken = randomBytes(48).toString("base64url");
  const accessToken = app.jwt.sign({ sub: userId });

  await app.prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + refreshTokenTtlMs),
    },
  });

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  };
}

export async function register(app: FastifyInstance, input: RegisterInput) {
  const existingUser = await app.prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existingUser) {
    throw AppError.conflict("An account with this email already exists");
  }

  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await app.prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash,
    },
    select: publicUserSelect,
  });

  const tokens = await createTokenPair(app, user.id);

  return {
    user,
    ...tokens,
  };
}

export async function login(app: FastifyInstance, input: LoginInput) {
  const user = await app.prisma.user.findUnique({
    where: { email: input.email },
    select: {
      ...publicUserSelect,
      passwordHash: true,
    },
  });

  if (!user) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const passwordMatches = await argon2.verify(user.passwordHash, input.password);

  if (!passwordMatches) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const tokens = await createTokenPair(app, user.id);

  return {
    user: toPublicUser(user),
    ...tokens,
  };
}

export async function refresh(app: FastifyInstance, input: RefreshTokenInput): Promise<TokenPair> {
  const tokenHash = hashToken(input.refreshToken);

  const storedToken = await app.prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!storedToken || storedToken.revokedAt || storedToken.expiresAt <= new Date()) {
    throw AppError.unauthorized("Invalid refresh token");
  }

  const refreshToken = randomBytes(48).toString("base64url");
  const accessToken = app.jwt.sign({ sub: storedToken.userId });
  const now = new Date();

  const rotated = await app.prisma.$transaction(async (transaction) => {
    const revoked = await transaction.refreshToken.updateMany({
      where: {
        id: storedToken.id,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        revokedAt: now,
      },
    });

    if (revoked.count === 0) {
      return false;
    }

    await transaction.refreshToken.create({
      data: {
        userId: storedToken.userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(now.getTime() + refreshTokenTtlMs),
      },
    });

    return true;
  });

  if (!rotated) {
    throw AppError.unauthorized("Invalid refresh token");
  }

  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  };
}

export async function logout(app: FastifyInstance, input: RefreshTokenInput): Promise<void> {
  await app.prisma.refreshToken.updateMany({
    where: {
      tokenHash: hashToken(input.refreshToken),
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}
