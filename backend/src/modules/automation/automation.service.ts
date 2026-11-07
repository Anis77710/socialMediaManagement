import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { addDays, startOfNptDay } from "../../lib/nepali.js";
import { nextWeekday, weekStartNpt } from "../../lib/time.js";
import type { PostService } from "../posts/post.service.js";

export type AutomationService = ReturnType<typeof createAutomationService>;

export function createAutomationService(deps: {
  prisma: PrismaClient;
  posts: PostService;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function get(businessId: string) {
    return deps.prisma.automationRule.findUnique({ where: { businessId } });
  }

  async function upsert(
    businessId: string,
    userId: string,
    input: {
      maxPostsPerWeek?: number;
      allowedWeekdays?: number[];
      windowStart?: string;
      windowEnd?: string;
      blockedKeywords?: string[];
      accountIds?: string[];
      paused?: boolean;
      pausedUntil?: Date | null;
      adBudgetCapPaisa?: number;
    },
  ) {
    return deps.prisma.automationRule.upsert({
      where: { businessId },
      create: {
        businessId,
        maxPostsPerWeek: input.maxPostsPerWeek ?? 3,
        allowedWeekdays: input.allowedWeekdays ?? [0, 1, 2, 3, 4],
        windowStart: input.windowStart ?? "10:00",
        windowEnd: input.windowEnd ?? "19:00",
        blockedKeywords: input.blockedKeywords ?? [],
        accountIds: input.accountIds ?? [],
        paused: input.paused ?? false,
        pausedUntil: input.pausedUntil ?? null,
        adBudgetCapPaisa: input.adBudgetCapPaisa ?? 0,
        updatedById: userId,
      },
      update: {
        ...(input.maxPostsPerWeek !== undefined ? { maxPostsPerWeek: input.maxPostsPerWeek } : {}),
        ...(input.allowedWeekdays !== undefined
          ? { allowedWeekdays: input.allowedWeekdays }
          : {}),
        ...(input.windowStart !== undefined ? { windowStart: input.windowStart } : {}),
        ...(input.windowEnd !== undefined ? { windowEnd: input.windowEnd } : {}),
        ...(input.blockedKeywords !== undefined
          ? { blockedKeywords: input.blockedKeywords }
          : {}),
        ...(input.accountIds !== undefined ? { accountIds: input.accountIds } : {}),
        ...(input.paused !== undefined ? { paused: input.paused } : {}),
        ...(input.pausedUntil !== undefined ? { pausedUntil: input.pausedUntil } : {}),
        ...(input.adBudgetCapPaisa !== undefined
          ? { adBudgetCapPaisa: input.adBudgetCapPaisa }
          : {}),
        updatedById: userId,
      },
    });
  }

  async function pause(businessId: string, userId: string, until?: Date | null) {
    return upsert(businessId, userId, { paused: true, pausedUntil: until ?? null });
  }

  async function resume(businessId: string, userId: string) {
    return upsert(businessId, userId, { paused: false, pausedUntil: null });
  }

  async function runAutopilot(limit = 10): Promise<number> {
    const at = now();
    const rules = await deps.prisma.automationRule.findMany({
      where: {
        paused: false,
        business: {
          status: "ACTIVE",
          autonomyMode: "AUTOPILOT",
          deletedAt: null,
        },
      },
      include: { business: true },
      take: limit,
    });
    let created = 0;

    for (const rule of rules) {
      if (rule.pausedUntil && rule.pausedUntil > at) {
        continue;
      }

      const weekStart = weekStartNpt(at);
      const weekEnd = addDays(weekStart, 7);
      const countThisWeek = await deps.prisma.post.count({
        where: {
          businessId: rule.businessId,
          source: "AUTOPILOT",
          createdAt: { gte: weekStart, lt: weekEnd },
        },
      });

      if (countThisWeek >= rule.maxPostsPerWeek) {
        continue;
      }

      const accounts = await deps.prisma.socialAccount.findMany({
        where: {
          businessId: rule.businessId,
          status: "ACTIVE",
          ...(rule.accountIds.length > 0 ? { id: { in: rule.accountIds } } : {}),
        },
        take: 3,
      });

      if (accounts.length === 0) {
        continue;
      }

      const idea = await deps.prisma.ideaTemplate.findFirst({
        where: {
          active: true,
          OR: [
            { categoryIds: { has: rule.business.categoryId } },
            { categoryIds: { isEmpty: true } },
          ],
        },
        orderBy: { updatedAt: "desc" },
      });

      if (!idea) {
        continue;
      }

      const scheduledAt = nextWeekday(at, rule.allowedWeekdays, rule.windowStart);

      if (scheduledAt <= at) {
        continue;
      }

      const post = await deps.posts.create({
        business: rule.business,
        userId: rule.business.ownerId,
        format: "IMAGE",
        title: idea.titleNe,
        brief: rule.business.language === "NE" ? idea.briefNe : idea.briefEn,
        language: rule.business.language,
        socialAccountIds: accounts.map((account) => account.id),
        source: "AUTOPILOT",
      });

      await deps.posts.submit(rule.businessId, post.id, {
        scheduledAt,
        publishNow: false,
        actor: "OWNER",
      });
      created += 1;
    }

    return created;
  }

  async function suggestSlots(businessId: string) {
    const rule = await get(businessId);

    if (!rule) {
      throw AppError.notFound("Automation rules not found");
    }

    const at = now();
    const slots = [];

    for (let index = 0; index < 4; index += 1) {
      const candidate = nextWeekday(addDays(at, index), rule.allowedWeekdays, rule.windowStart);
      slots.push(candidate);
    }

    return {
      slots: [...new Set(slots.map((slot) => slot.toISOString()))].map((slot) => new Date(slot)),
      weekStart: startOfNptDay(weekStartNpt(at)),
      maxPostsPerWeek: rule.maxPostsPerWeek,
    };
  }

  return { get, upsert, pause, resume, runAutopilot, suggestSlots };
}
