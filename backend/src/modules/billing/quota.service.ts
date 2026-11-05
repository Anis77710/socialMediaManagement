import type { Prisma} from "../../generated/prisma/client.js";
import { type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";

export type QuotaKind = "POST" | "REEL";

export type UsagePeriodRow = {
  id: string;
  businessId: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date | null;
  postsLimit: number;
  postsUsed: number;
  reelsLimit: number;
  reelsUsed: number;
};

export type QuotaView = {
  periodId: string;
  periodStart: Date;
  periodEnd: Date | null;
  posts: { used: number; limit: number; remaining: number };
  reels: { used: number; limit: number; remaining: number };
  locked: boolean;
};

export function createQuotaService(prisma: PrismaClient, now: () => Date = () => new Date()) {
  async function activePeriod(businessId: string): Promise<UsagePeriodRow | null> {
    const rows = await prisma.$queryRaw<UsagePeriodRow[]>`
      SELECT * FROM "usage_periods"
      WHERE "businessId" = ${businessId}
        AND ("periodEnd" IS NULL OR "periodEnd" > ${now()})
      ORDER BY "periodStart" DESC
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

  async function view(businessId: string): Promise<QuotaView> {
    const period = await activePeriod(businessId);

    if (!period) {
      throw new AppError(409, "SUBSCRIPTION_REQUIRED", "No active subscription period");
    }

    return {
      periodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      posts: {
        used: period.postsUsed,
        limit: period.postsLimit,
        remaining: Math.max(0, period.postsLimit - period.postsUsed),
      },
      reels: {
        used: period.reelsUsed,
        limit: period.reelsLimit,
        remaining: Math.max(0, period.reelsLimit - period.reelsUsed),
      },
      locked: period.postsUsed >= period.postsLimit && period.reelsUsed >= period.reelsLimit,
    };
  }

  async function consume(businessId: string, kind: QuotaKind): Promise<UsagePeriodRow> {
    const period = await activePeriod(businessId);

    if (!period) {
      throw new AppError(402, "QUOTA_EXHAUSTED", "No active subscription period", {
        upgradeOptions: ["basic", "standard", "premium"],
      });
    }

    const rows =
      kind === "POST"
        ? await prisma.$queryRaw<UsagePeriodRow[]>`
            UPDATE "usage_periods"
            SET "postsUsed" = "postsUsed" + 1
            WHERE "id" = ${period.id} AND "postsUsed" < "postsLimit"
            RETURNING *
          `
        : await prisma.$queryRaw<UsagePeriodRow[]>`
            UPDATE "usage_periods"
            SET "reelsUsed" = "reelsUsed" + 1
            WHERE "id" = ${period.id} AND "reelsUsed" < "reelsLimit"
            RETURNING *
          `;
    const updated = rows[0];

    if (!updated) {
      throw new AppError(402, "QUOTA_EXHAUSTED", "Your plan quota is exhausted", {
        kind,
        upgradeOptions: ["basic", "standard", "premium"],
      });
    }

    return updated;
  }

  async function refund(businessId: string, kind: QuotaKind): Promise<void> {
    const period = await activePeriod(businessId);

    if (!period) {
      return;
    }

    if (kind === "POST") {
      await prisma.$executeRaw`
        UPDATE "usage_periods"
        SET "postsUsed" = GREATEST(0, "postsUsed" - 1)
        WHERE "id" = ${period.id}
      `;
    } else {
      await prisma.$executeRaw`
        UPDATE "usage_periods"
        SET "reelsUsed" = GREATEST(0, "reelsUsed" - 1)
        WHERE "id" = ${period.id}
      `;
    }
  }

  async function createPeriod(
    tx: Prisma.TransactionClient,
    input: {
      businessId: string;
      subscriptionId: string;
      periodStart: Date;
      periodEnd: Date | null;
      postsLimit: number;
      reelsLimit: number;
    },
  ): Promise<void> {
    await tx.usagePeriod.create({
      data: {
        businessId: input.businessId,
        subscriptionId: input.subscriptionId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        postsLimit: input.postsLimit,
        reelsLimit: input.reelsLimit,
      },
    });
  }

  return { activePeriod, view, consume, refund, createPeriod };
}

export type QuotaService = ReturnType<typeof createQuotaService>;
