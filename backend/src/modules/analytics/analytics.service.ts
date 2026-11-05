import type { PrismaClient } from "../../generated/prisma/client.js";
import { nptWeekday, weekStartNpt } from "../../lib/time.js";
import { startOfNptDay } from "../../lib/nepali.js";
import { formatNpr } from "../../lib/money.js";
import type { ConnectionService } from "../connections/connection.service.js";
import type { QuotaService } from "../billing/quota.service.js";
import type { SocialPublishers } from "../../providers/social/index.js";

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;

type MetricSet = {
  reach: number;
  views: number;
  engagements: number;
  followers: number;
  saves: number;
  linkClicks: number;
};

const EMPTY_METRICS: MetricSet = {
  reach: 0,
  views: 0,
  engagements: 0,
  followers: 0,
  saves: 0,
  linkClicks: 0,
};

function asMetrics(value: unknown): Partial<MetricSet> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const result: Partial<MetricSet> = {};

  for (const key of Object.keys(EMPTY_METRICS) as (keyof MetricSet)[]) {
    const entry = record[key];

    if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry;
    }
  }

  return result;
}

export function createAnalyticsService(deps: {
  prisma: PrismaClient;
  connections: ConnectionService;
  quota: QuotaService;
  publishers: SocialPublishers;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  function range(from?: Date, to?: Date) {
    const end = to ?? now();
    const start = from ?? new Date(end.getTime() - 30 * 86_400_000);

    return { start, end };
  }

  async function overview(businessId: string, from?: Date, to?: Date) {
    const { start, end } = range(from, to);
    const [published, targets, snapshots, sales, quota] = await Promise.all([
      deps.prisma.post.count({
        where: {
          businessId,
          status: { in: ["PUBLISHED", "PARTIALLY_PUBLISHED"] },
          publishedAt: { gte: start, lte: end },
        },
      }),
      deps.prisma.postTarget.findMany({
        where: {
          post: { businessId },
          status: "PUBLISHED",
          publishedAt: { gte: start, lte: end },
        },
        select: { id: true, publishedAt: true },
      }),
      deps.prisma.insightSnapshot.findMany({
        where: {
          socialAccount: { businessId },
          date: { gte: startOfNptDay(start), lte: end },
        },
        orderBy: { date: "desc" },
      }),
      deps.prisma.salesRecord.aggregate({
        where: { businessId, occurredAt: { gte: start, lte: end } },
        _sum: { amountPaisa: true },
        _count: true,
      }),
      deps.quota.view(businessId).catch(() => null),
    ]);
    const insights = await deps.prisma.postInsight.findMany({
      where: { postTargetId: { in: targets.map((target) => target.id) } },
      orderBy: { fetchedAt: "desc" },
    });
    const latestByTarget = new Map<string, (typeof insights)[number]>();

    for (const insight of insights) {
      if (!latestByTarget.has(insight.postTargetId)) {
        latestByTarget.set(insight.postTargetId, insight);
      }
    }

    const metrics = { ...EMPTY_METRICS };

    for (const insight of latestByTarget.values()) {
      const values = asMetrics(insight.metrics);

      for (const key of Object.keys(metrics) as (keyof MetricSet)[]) {
        metrics[key] += values[key] ?? 0;
      }
    }

    const followers = new Map<string, number>();

    for (const snapshot of snapshots) {
      if (followers.has(snapshot.socialAccountId)) {
        continue;
      }

      const values = asMetrics(snapshot.metrics);
      followers.set(snapshot.socialAccountId, values.followers ?? 0);
    }

    metrics.followers = [...followers.values()].reduce((sum, value) => sum + value, 0);

    return {
      range: { from: start, to: end },
      publishedPosts: published,
      metrics,
      sales: {
        count: sales._count,
        amountPaisa: sales._sum.amountPaisa ?? 0,
        formatted: formatNpr(sales._sum.amountPaisa ?? 0),
      },
      quota,
    };
  }

  async function postPerformance(businessId: string, from?: Date, to?: Date, limit = 20) {
    const { start, end } = range(from, to);
    const targets = await deps.prisma.postTarget.findMany({
      where: {
        post: { businessId },
        status: "PUBLISHED",
        publishedAt: { gte: start, lte: end },
      },
      include: {
        post: { select: { id: true, title: true, format: true, publishedAt: true } },
        socialAccount: { select: { platform: true, displayName: true } },
        insights: { orderBy: { fetchedAt: "desc" }, take: 1 },
      },
      orderBy: { publishedAt: "desc" },
      take: limit,
    });

    return targets.map((target) => ({
      targetId: target.id,
      post: target.post,
      platform: target.socialAccount.platform,
      account: target.socialAccount.displayName,
      externalUrl: target.externalUrl,
      publishedAt: target.publishedAt,
      metrics: asMetrics(target.insights[0]?.metrics),
    }));
  }

  async function bestTimes(businessId: string) {
    const targets = await deps.prisma.postTarget.findMany({
      where: {
        post: { businessId },
        status: "PUBLISHED",
        publishedAt: { not: null },
      },
      include: { insights: { orderBy: { fetchedAt: "desc" }, take: 1 } },
      take: 500,
    });
    const buckets = new Map<
      string,
      { weekday: number; hour: number; posts: number; engagement: number; reach: number }
    >();

    for (const target of targets) {
      if (!target.publishedAt) {
        continue;
      }

      const weekday = nptWeekday(target.publishedAt);
      const hour = new Date(target.publishedAt.getTime() + (5 * 60 + 45) * 60_000).getUTCHours();
      const key = `${weekday}:${hour}`;
      const bucket = buckets.get(key) ?? {
        weekday,
        hour,
        posts: 0,
        engagement: 0,
        reach: 0,
      };
      const metrics = asMetrics(target.insights[0]?.metrics);
      bucket.posts += 1;
      bucket.engagement += metrics.engagements ?? 0;
      bucket.reach += metrics.reach ?? 0;
      buckets.set(key, bucket);
    }

    const all = [...buckets.values()];
    const trusted = all.filter((bucket) => bucket.posts >= 3);
    const source = trusted.length > 0 ? trusted : all;

    return {
      sampleSize: targets.length,
      confident: trusted.length > 0,
      slots: source
        .sort((left, right) => {
          const leftScore = left.posts > 0 ? left.engagement / left.posts : 0;
          const rightScore = right.posts > 0 ? right.engagement / right.posts : 0;

          return rightScore - leftScore;
        })
        .slice(0, 5),
    };
  }

  async function createSale(input: {
    businessId: string;
    amountPaisa: number;
    occurredAt: Date;
    source?: string;
    note?: string | null;
    attributedPostId?: string | null;
  }) {
    return deps.prisma.salesRecord.create({
      data: {
        businessId: input.businessId,
        amountPaisa: input.amountPaisa,
        occurredAt: input.occurredAt,
        source: input.source ?? "MANUAL",
        note: input.note ?? null,
        attributedPostId: input.attributedPostId ?? null,
      },
    });
  }

  async function listSales(businessId: string, from?: Date, to?: Date) {
    const { start, end } = range(from, to);

    return deps.prisma.salesRecord.findMany({
      where: { businessId, occurredAt: { gte: start, lte: end } },
      orderBy: { occurredAt: "desc" },
      take: 200,
    });
  }

  async function syncInsights(businessId?: string): Promise<{ accounts: number; targets: number }> {
    const accounts = await deps.prisma.socialAccount.findMany({
      where: {
        status: "ACTIVE",
        ...(businessId ? { businessId } : {}),
      },
    });
    const at = now();
    let targetCount = 0;

    for (const account of accounts) {
      try {
        const decrypted = await deps.connections.getDecrypted(account.id);
        const result = await deps.publishers[account.platform].fetchInsights({
          platform: account.platform,
          externalId: account.externalId,
          accessToken: decrypted.accessToken,
          since: new Date(at.getTime() - 30 * 86_400_000),
          until: at,
        });
        await deps.prisma.insightSnapshot.upsert({
          where: {
            socialAccountId_date: {
              socialAccountId: account.id,
              date: startOfNptDay(at),
            },
          },
          create: {
            socialAccountId: account.id,
            date: startOfNptDay(at),
            metrics: result.metrics,
            isFinal: false,
          },
          update: { metrics: result.metrics, fetchedAt: at },
        });
        const publishedTargets = await deps.prisma.postTarget.findMany({
          where: { socialAccountId: account.id, status: "PUBLISHED" },
          orderBy: { publishedAt: "desc" },
          take: 20,
        });

        for (const target of publishedTargets) {
          if (!target.externalPostId) {
            continue;
          }

          try {
            const postInsight = await deps.publishers[account.platform].fetchInsights({
              platform: account.platform,
              externalId: account.externalId,
              accessToken: decrypted.accessToken,
              since: target.publishedAt ?? new Date(at.getTime() - 30 * 86_400_000),
              until: at,
              postExternalId: target.externalPostId,
            });
            await deps.prisma.postInsight.create({
              data: {
                postTargetId: target.id,
                metrics: postInsight.metrics,
              },
            });
            targetCount += 1;
          } catch {
            // A single post insight failure must not stop the account sync.
          }
        }
      } catch (error) {
        await deps.prisma.socialAccount.update({
          where: { id: account.id },
          data: {
            lastCheckedAt: at,
            lastError: error instanceof Error ? error.message.slice(0, 500) : "Insight sync failed",
          },
        });
      }
    }

    return { accounts: accounts.length, targets: targetCount };
  }

  async function weeklyReport(businessId: string, weekStart?: Date) {
    const start = weekStart ?? weekStartNpt(now());
    const end = new Date(start.getTime() + 7 * 86_400_000);
    const data = await overview(businessId, start, end);
    const numbers = {
      publishedPosts: data.publishedPosts,
      reach: data.metrics.reach,
      views: data.metrics.views,
      engagements: data.metrics.engagements,
      followers: data.metrics.followers,
      salesPaisa: data.sales.amountPaisa,
    };
    const textNe = [
      `यो हप्ता ${data.publishedPosts} पोस्ट प्रकाशित भयो।`,
      `कुल पहुँच ${data.metrics.reach} र engagement ${data.metrics.engagements} रह्यो।`,
      `बिक्री ${formatNpr(data.sales.amountPaisa, "NE")} भयो।`,
    ].join(" ");
    const textEn = [
      `${data.publishedPosts} posts were published this week.`,
      `Total reach was ${data.metrics.reach} with ${data.metrics.engagements} engagements.`,
      `Sales recorded ${formatNpr(data.sales.amountPaisa)}.`,
    ].join(" ");

    return deps.prisma.weeklyReport.upsert({
      where: { businessId_weekStart: { businessId, weekStart: startOfNptDay(start) } },
      create: {
        businessId,
        weekStart: startOfNptDay(start),
        numbers,
        textNe,
        textEn,
      },
      update: { numbers, textNe, textEn },
    });
  }

  async function listReports(businessId: string) {
    return deps.prisma.weeklyReport.findMany({
      where: { businessId },
      orderBy: { weekStart: "desc" },
      take: 12,
    });
  }

  return {
    overview,
    postPerformance,
    bestTimes,
    createSale,
    listSales,
    syncInsights,
    weeklyReport,
    listReports,
  };
}
