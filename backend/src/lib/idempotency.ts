import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { AppError } from "./errors.js";

const TTL_MS = 24 * 60 * 60 * 1000;

export function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export function requireIdempotencyKey(key: string | string[] | undefined): string {
  if (typeof key !== "string" || key.trim().length < 8 || key.length > 200) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required",
    );
  }

  return key;
}

export async function withIdempotency<T>(
  prisma: PrismaClient,
  input: { scope: string; key: string; requestHash: string },
  handler: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { scope_key: { scope: input.scope, key: input.key } },
  });

  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was used with a different request",
      );
    }

    if (existing.response !== null) {
      return {
        status: existing.status ?? 200,
        body: existing.response as T,
        replayed: true,
      };
    }
  }

  const result = await handler();

  await prisma.idempotencyRecord.upsert({
    where: { scope_key: { scope: input.scope, key: input.key } },
    create: {
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      response: result.body as Prisma.InputJsonValue,
      status: result.status,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
    update: {
      response: result.body as Prisma.InputJsonValue,
      status: result.status,
    },
  });

  return { ...result, replayed: false };
}
