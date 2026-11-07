import type { Lang, Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { QuotaService } from "../billing/quota.service.js";

export type BusinessService = ReturnType<typeof createBusinessService>;

export function createBusinessService(deps: {
  prisma: PrismaClient;
  quota: QuotaService;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function findForUser(userId: string, businessId?: string | null) {
    const business = await deps.prisma.business.findFirst({
      where: {
        deletedAt: null,
        ...(businessId ? { id: businessId } : {}),
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      include: {
        category: true,
        town: true,
        subscription: { include: { plan: true, pendingPlan: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return business;
  }

  async function requireForUser(userId: string, businessId?: string | null) {
    const business = await findForUser(userId, businessId);

    if (!business) {
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Business profile not found");
    }

    return business;
  }

  async function create(
    userId: string,
    input: {
      name: string;
      categoryId: string;
      townId?: string | null;
      townText: string;
      customerPhone?: string | null;
      language: Lang;
      panNumber?: string | null;
    },
  ) {
    const existing = await deps.prisma.business.findFirst({
      where: { ownerId: userId, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      throw new AppError(409, "BUSINESS_EXISTS", "A business profile already exists");
    }

    const category = await deps.prisma.businessCategory.findUnique({
      where: { id: input.categoryId },
    });

    if (!category || !category.active) {
      throw new AppError(400, "INVALID_CATEGORY", "Choose a valid business category");
    }

    if (input.townId) {
      const town = await deps.prisma.town.findUnique({ where: { id: input.townId } });

      if (!town) {
        throw new AppError(400, "INVALID_TOWN", "Choose a valid town");
      }
    }

    const freePlan = await deps.prisma.plan.findUnique({ where: { id: "free" } });
    const at = now();

    return deps.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          ownerId: userId,
          name: input.name.trim(),
          categoryId: input.categoryId,
          townId: input.townId ?? null,
          townText: input.townText.trim(),
          customerPhone: input.customerPhone ?? null,
          language: input.language,
          panNumber: input.panNumber ?? null,
          onboardingStep: "CONNECT",
          members: { create: { userId, role: "OWNER" } },
        },
        include: { category: true, town: true },
      });

      if (freePlan) {
        const limits = {
          posts: freePlan.postsPerPeriod,
          reels: freePlan.reelsPerPeriod,
          accounts: freePlan.maxAccounts,
          features: freePlan.features,
        };
        const subscription = await tx.subscription.create({
          data: {
            businessId: business.id,
            planId: freePlan.id,
            pricePaisaSnapshot: freePlan.pricePaisa,
            limitsSnapshot: limits,
            currentPeriodStart: at,
            currentPeriodEnd: null,
          },
        });

        await deps.quota.createPeriod(tx, {
          businessId: business.id,
          subscriptionId: subscription.id,
          periodStart: at,
          periodEnd: null,
          postsLimit: freePlan.postsPerPeriod,
          reelsLimit: freePlan.reelsPerPeriod,
        });
      }

      return business;
    });
  }

  async function update(
    userId: string,
    businessId: string | null,
    input: {
      name?: string;
      categoryId?: string;
      townId?: string | null;
      townText?: string;
      customerPhone?: string | null;
      language?: Lang;
      panNumber?: string | null;
      logoAssetId?: string | null;
      autonomyMode?: "MANUAL" | "APPROVAL" | "AUTOPILOT";
    },
  ) {
    const business = await requireForUser(userId, businessId);

    if (input.categoryId) {
      const category = await deps.prisma.businessCategory.findUnique({
        where: { id: input.categoryId },
      });

      if (!category || !category.active) {
        throw new AppError(400, "INVALID_CATEGORY", "Choose a valid business category");
      }
    }

    const data: Prisma.BusinessUpdateInput = {};

    if (input.name !== undefined) {
      data.name = input.name.trim();
    }

    if (input.categoryId !== undefined) {
      data.category = { connect: { id: input.categoryId } };
    }

    if (input.townId !== undefined) {
      data.town = input.townId ? { connect: { id: input.townId } } : { disconnect: true };
    }

    if (input.townText !== undefined) {
      data.townText = input.townText.trim();
    }

    if (input.customerPhone !== undefined) {
      data.customerPhone = input.customerPhone;
    }

    if (input.language !== undefined) {
      data.language = input.language;
    }

    if (input.panNumber !== undefined) {
      data.panNumber = input.panNumber;
    }

    if (input.logoAssetId !== undefined) {
      data.logoAssetId = input.logoAssetId;
    }

    if (input.autonomyMode !== undefined) {
      data.autonomyMode = input.autonomyMode;
    }

    return deps.prisma.business.update({
      where: { id: business.id },
      data,
      include: { category: true, town: true },
    });
  }

  async function onboarding(userId: string, businessId?: string | null) {
    const business = await findForUser(userId, businessId);

    if (!business) {
      return {
        step: "BUSINESS" as const,
        business: null,
        connectionsUsed: 0,
        connectionsLimit: 1,
        firstPostId: null,
        quota: null,
      };
    }

    const [connectionsUsed, firstPost, subscription, quota] = await Promise.all([
      deps.prisma.socialAccount.count({
        where: { businessId: business.id, status: "ACTIVE" },
      }),
      deps.prisma.post.findFirst({
        where: { businessId: business.id },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
      deps.prisma.subscription.findUnique({
        where: { businessId: business.id },
        include: { plan: true },
      }),
      deps.quota.view(business.id).catch(() => null),
    ]);
    const limits = subscription?.limitsSnapshot as { accounts?: number } | null;
    const connectionsLimit = limits?.accounts ?? subscription?.plan.maxAccounts ?? 1;
    let step = business.onboardingStep;

    if (step === "CONNECT" && connectionsUsed > 0) {
      step = firstPost ? "DONE" : "FIRST_POSTER";
    }

    return {
      step,
      business,
      connectionsUsed,
      connectionsLimit,
      firstPostId: firstPost?.id ?? null,
      quota,
    };
  }

  async function markStep(businessId: string, step: string) {
    await deps.prisma.business.update({
      where: { id: businessId },
      data: { onboardingStep: step },
    });
  }

  async function listCategories() {
    return deps.prisma.businessCategory.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    });
  }

  async function searchTowns(query: string) {
    return deps.prisma.town.findMany({
      where: query
        ? {
            OR: [
              { nameEn: { contains: query, mode: "insensitive" } },
              { nameNe: { contains: query } },
              { district: { contains: query, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { nameEn: "asc" },
      take: 50,
    });
  }

  return {
    findForUser,
    requireForUser,
    create,
    update,
    onboarding,
    markStep,
    listCategories,
    searchTowns,
  };
}
