import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type OutboxInput = {
  type: string;
  payload: Prisma.InputJsonValue;
  availableAt?: Date;
};

export async function enqueueOutbox(db: Db, input: OutboxInput): Promise<void> {
  await db.outboxEvent.create({
    data: {
      type: input.type,
      payload: input.payload,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
  });
}

export async function claimOutboxBatch(
  prisma: PrismaClient,
  limit = 50,
): Promise<{ id: string; type: string; payload: Prisma.JsonValue; attempts: number }[]> {
  return prisma.$queryRaw`
    UPDATE "outbox_events"
    SET "attempts" = "attempts" + 1,
        "availableAt" = now() + interval '30 seconds'
    WHERE "id" IN (
      SELECT "id" FROM "outbox_events"
      WHERE "processedAt" IS NULL AND "availableAt" <= now()
      ORDER BY "availableAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING "id", "type", "payload", "attempts"
  `;
}
