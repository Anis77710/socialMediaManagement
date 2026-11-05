import { randomUUID } from "node:crypto";
import type {
  Business,
  Lang,
  PostFormat,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { decodeCursor, cursorWhere, pageResult } from "../../lib/cursor.js";
import type { AssetService } from "../assets/asset.service.js";
import type { ConnectionService } from "../connections/connection.service.js";
import type { ContentService } from "../creatives/content.service.js";
import type { QuotaService } from "../billing/quota.service.js";
import type { NotificationService } from "../notifications/notification.service.js";
import type { Renderer } from "../../providers/renderer/types.js";
import type { SocialPublishers } from "../../providers/social/index.js";

const EDITABLE: string[] = ["DRAFT", "REJECTED"];

export type PostService = ReturnType<typeof createPostService>;

export function createPostService(deps: {
  prisma: PrismaClient;
  content: ContentService;
  assets: AssetService;
  quota: QuotaService;
  connections: ConnectionService;
  notifications: NotificationService;
  renderer: Renderer;
  publishers: SocialPublishers;
  reviewSlaHours: number;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function requirePost(businessId: string, postId: string) {
    const post = await deps.prisma.post.findFirst({
      where: { id: postId, businessId },
      include: {
        creatives: { orderBy: { version: "desc" }, take: 1 },
        targets: { include: { socialAccount: true } },
        approvals: { orderBy: { requestedAt: "desc" }, take: 1 },
        business: true,
      },
    });

    if (!post) {
      throw AppError.notFound("Post not found");
    }

    return post;
  }

  async function validateTargets(businessId: string, socialAccountIds: string[]) {
    if (socialAccountIds.length === 0) {
      throw new AppError(400, "TARGET_REQUIRED", "Choose at least one connected account");
    }

    const accounts = await deps.prisma.socialAccount.findMany({
      where: {
        id: { in: [...new Set(socialAccountIds)] },
        businessId,
        status: "ACTIVE",
      },
    });

    if (accounts.length !== new Set(socialAccountIds).size) {
      throw new AppError(400, "INVALID_TARGET", "One or more connected accounts are invalid");
    }

    return accounts;
  }

  async function renderCreative(input: {
    business: Business;
    postId: string;
    version: number;
    generated: Awaited<ReturnType<ContentService["generate"]>>;
    format: PostFormat;
  }) {
    const png = (
      await deps.renderer.poster({
        templateKey: input.generated.templateKey,
        inverted: input.generated.inverted,
        eyebrow: input.generated.texts.eyebrow,
        headline: input.generated.texts.headline,
        value: input.generated.facts.primary?.text ?? null,
        unit: input.generated.facts.primary?.unit ?? null,
        businessName: input.business.name,
        phone: input.business.customerPhone,
        ...(input.format === "REEL" ? { width: 1080, height: 1920 } : {}),
      })
    ).png;

    return deps.assets.saveBuffer({
      businessId: input.business.id,
      kind: "poster",
      buffer: png,
      mime: "image/png",
      isPublic: true,
      width: input.format === "REEL" ? 1080 : 1080,
      height: input.format === "REEL" ? 1920 : 1350,
    });
  }

  async function create(input: {
    business: Business;
    userId: string;
    format: PostFormat;
    title?: string;
    brief: string;
    language: Lang;
    occasion?: string | null;
    socialAccountIds: string[];
    source?: "MANUAL" | "IDEA" | "FESTIVAL_CAMPAIGN" | "AUTOPILOT" | "STAFF";
    festivalId?: string | null;
    campaignId?: string | null;
    templateKey?: string;
  }) {
    const accounts = await validateTargets(input.business.id, input.socialAccountIds);
    const generated = await deps.content.generate({
      business: input.business,
      brief: input.brief,
      language: input.language,
      occasion: input.occasion ?? null,
      templateKey: input.templateKey,
    });
    const title =
      input.title?.trim() ||
      generated.texts.headline.slice(0, 120) ||
      input.brief.slice(0, 120);

    const post = await deps.prisma.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          businessId: input.business.id,
          createdById: input.userId,
          format: input.format,
          source: input.source ?? "MANUAL",
          status: "DRAFT",
          title,
          brief: input.brief,
          occasion: input.occasion ?? null,
          language: input.language,
          caption: generated.texts.caption,
          hasOfferFacts: generated.facts.hasOfferFacts,
          festivalId: input.festivalId ?? null,
          campaignId: input.campaignId ?? null,
          targets: {
            create: accounts.map((account) => ({
              socialAccountId: account.id,
              idempotencyKey: randomUUID(),
            })),
          },
        },
      });
      let asset: Awaited<ReturnType<typeof renderCreative>> | null = null;
      try {
        asset = await renderCreative({
          business: input.business,
          postId: created.id,
          version: 1,
          generated,
          format: input.format,
        });
      } catch {
        asset = null;
      }
      const creative = await tx.creative.create({
        data: {
          postId: created.id,
          version: 1,
          variant: 1,
          templateKey: generated.templateKey,
          inverted: generated.inverted,
          eyebrow: generated.texts.eyebrow,
          headline: generated.texts.headline,
          value: generated.facts.primary?.text ?? null,
          unit: generated.facts.primary?.unit ?? null,
          caption: generated.texts.caption,
          facts: generated.facts,
          aiMeta: (generated.aiMeta ?? undefined) as Prisma.InputJsonValue | undefined,
          validation: generated.validation,
          renderStatus: asset ? "READY" : "PENDING",
            assetId: asset?.id ?? null,
          contentHash: generated.contentHash,
        },
      });

      await tx.post.update({
        where: { id: created.id },
        data: { currentCreativeId: creative.id },
      });

      return created;
    });

    await maybeAdvanceOnboarding(input.business.id);

    return requirePost(input.business.id, post.id);
  }

  async function update(
    businessId: string,
    postId: string,
    input: {
      title?: string;
      brief?: string;
      language?: Lang;
      format?: PostFormat;
      occasion?: string | null;
      socialAccountIds?: string[];
      templateKey?: string;
      caption?: string;
    },
  ) {
    const post = await requirePost(businessId, postId);

    if (!EDITABLE.includes(post.status)) {
      throw new AppError(409, "POST_NOT_EDITABLE", "This post can no longer be edited", {
        status: post.status,
      });
    }

    let generated: Awaited<ReturnType<ContentService["generate"]>> | null = null;

    if (input.brief || input.language || input.templateKey) {
      generated = await deps.content.generate({
        business: post.business,
        brief: input.brief ?? post.brief,
        language: input.language ?? post.language,
        occasion: input.occasion ?? post.occasion,
        templateKey: input.templateKey,
      });
    }

    if (input.socialAccountIds) {
      await validateTargets(businessId, input.socialAccountIds);
    }

    const latest = post.creatives[0];
    const nextVersion = (latest?.version ?? 0) + 1;

    await deps.prisma.$transaction(async (tx) => {
      const data: Prisma.PostUpdateInput = {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.format !== undefined ? { format: input.format } : {}),
        ...(input.occasion !== undefined ? { occasion: input.occasion } : {}),
        ...(generated
          ? {
              caption: input.caption ?? generated.texts.caption,
              hasOfferFacts: generated.facts.hasOfferFacts,
            }
          : input.caption !== undefined
            ? { caption: input.caption }
            : {}),
      };

      if (input.socialAccountIds) {
        await tx.postTarget.deleteMany({ where: { postId } });
        await tx.postTarget.createMany({
          data: [...new Set(input.socialAccountIds)].map((socialAccountId) => ({
            postId,
            socialAccountId,
            idempotencyKey: randomUUID(),
          })),
        });
      }

      if (generated) {
        let asset: Awaited<ReturnType<typeof renderCreative>> | null = null;
        try {
          asset = await renderCreative({
            business: post.business,
            postId,
            version: nextVersion,
            generated,
            format: input.format ?? post.format,
          });
        } catch {
          asset = null;
        }
        const creative = await tx.creative.create({
          data: {
            postId,
            version: nextVersion,
            variant: nextVersion,
            templateKey: generated.templateKey,
            inverted: generated.inverted,
            eyebrow: generated.texts.eyebrow,
            headline: generated.texts.headline,
            value: generated.facts.primary?.text ?? null,
            unit: generated.facts.primary?.unit ?? null,
            caption: generated.texts.caption,
            facts: generated.facts,
            aiMeta: (generated.aiMeta ?? undefined) as Prisma.InputJsonValue | undefined,
            validation: generated.validation,
            renderStatus: asset ? "READY" : "PENDING",
            assetId: asset?.id ?? null,
            contentHash: generated.contentHash,
          },
        });
        data.currentCreativeId = creative.id;
        data.status = "DRAFT";
      }

      await tx.post.update({ where: { id: postId }, data });
    });

    return requirePost(businessId, postId);
  }

  async function list(
    businessId: string,
    query: {
      cursor?: string;
      limit?: number;
      status?: string;
      format?: PostFormat;
      from?: Date;
      to?: Date;
    },
  ) {
    const limit = Math.min(query.limit ?? 20, 100);
    const cursor = decodeCursor(query.cursor);
    const rows = await deps.prisma.post.findMany({
      where: {
        businessId,
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.format ? { format: query.format } : {}),
        ...(query.from || query.to
          ? {
              scheduledAt: {
                ...(query.from ? { gte: query.from } : {}),
                ...(query.to ? { lte: query.to } : {}),
              },
            }
          : {}),
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      include: {
        creatives: { orderBy: { version: "desc" }, take: 1 },
        targets: { include: { socialAccount: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    return pageResult(rows, limit);
  }

  async function submit(
    businessId: string,
    postId: string,
    input: { scheduledAt: Date | null; publishNow: boolean; actor: "OWNER" | "STAFF" },
  ) {
    const post = await requirePost(businessId, postId);

    if (!EDITABLE.includes(post.status)) {
      throw new AppError(409, "POST_NOT_EDITABLE", "This post has already been submitted", {
        status: post.status,
      });
    }

    if (post.targets.length === 0) {
      throw new AppError(400, "TARGET_REQUIRED", "Choose at least one connected account");
    }

    const at = now();

    if (input.scheduledAt && input.scheduledAt.getTime() < at.getTime() + 5 * 60_000) {
      throw new AppError(400, "SCHEDULE_TOO_SOON", "Schedule the post at least 5 minutes from now");
    }

    const needsApproval =
      post.business.autonomyMode === "APPROVAL" ||
      (post.business.autonomyMode === "MANUAL" && input.actor === "STAFF") ||
      post.requiresApproval;

    if (post.quotaConsumedAt === null) {
      await deps.quota.consume(businessId, post.format === "REEL" ? "REEL" : "POST");
    }

    if (needsApproval) {
      const approval = await deps.prisma.approval.create({
        data: {
          postId,
          expiresAt: new Date(at.getTime() + deps.reviewSlaHours * 3_600_000),
        },
      });

      await deps.prisma.post.update({
        where: { id: postId },
        data: {
          status: "PENDING_APPROVAL",
          scheduledAt: input.scheduledAt,
          quotaConsumedAt: at,
        },
      });
      await deps.notifications.notify({
        userId: post.business.ownerId,
        businessId,
        type: "POST_APPROVAL_REQUESTED",
        titleNe: "à¤ªà¥‹à¤¸à¥à¤Ÿ à¤¸à¥à¤µà¥€à¤•à¥ƒà¤¤à¤¿ à¤†à¤µà¤¶à¥à¤¯à¤•",
        titleEn: "Post needs your approval",
        bodyNe: `"${post.title}" à¤¸à¥à¤µà¥€à¤•à¥ƒà¤¤à¤¿à¤•à¥‹ à¤²à¤¾à¤—à¤¿ à¤ªà¤°à¥à¤–à¤¿à¤°à¤¹à¥‡à¤•à¥‹ à¤›à¥¤`,
        bodyEn: `"${post.title}" is waiting for your approval.`,
        data: { postId, approvalId: approval.id },
        channels: ["IN_APP", "PUSH"],
        dedupeKey: `approval:${approval.id}`,
      });

      return requirePost(businessId, postId);
    }

    const status = input.publishNow ? "PUBLISHING" : "SCHEDULED";
    await deps.prisma.post.update({
      where: { id: postId },
      data: {
        status,
        scheduledAt: input.publishNow ? at : input.scheduledAt,
        quotaConsumedAt: at,
      },
    });

    if (input.publishNow) {
      await enqueuePublish(postId);
    }

    return requirePost(businessId, postId);
  }

  async function decide(
    businessId: string,
    postId: string,
    input: { decision: "APPROVED" | "REJECTED"; feedback?: string; userId: string },
  ) {
    const post = await requirePost(businessId, postId);

    if (post.status !== "PENDING_APPROVAL") {
      throw new AppError(409, "NOT_PENDING_APPROVAL", "This post is not awaiting approval");
    }

    const approval = post.approvals[0];

    if (!approval) {
      throw new AppError(409, "APPROVAL_NOT_FOUND", "Approval request not found");
    }

    if (input.decision === "REJECTED") {
      await deps.prisma.$transaction([
        deps.prisma.approval.update({
          where: { id: approval.id },
          data: {
            decision: "REJECTED",
            decidedAt: now(),
            decidedById: input.userId,
            feedback: input.feedback ?? null,
          },
        }),
        deps.prisma.post.update({
          where: { id: postId },
          data: { status: "REJECTED", quotaConsumedAt: null },
        }),
      ]);
      await deps.quota.refund(businessId, post.format === "REEL" ? "REEL" : "POST");

      return requirePost(businessId, postId);
    }

    const scheduledAt = post.scheduledAt;
    const publishNow = !scheduledAt || scheduledAt <= now();
    await deps.prisma.$transaction([
      deps.prisma.approval.update({
        where: { id: approval.id },
        data: {
          decision: "APPROVED",
          decidedAt: now(),
          decidedById: input.userId,
          feedback: input.feedback ?? null,
        },
      }),
      deps.prisma.post.update({
        where: { id: postId },
        data: {
          status: publishNow ? "PUBLISHING" : "SCHEDULED",
          ...(publishNow ? { scheduledAt: now() } : {}),
        },
      }),
    ]);

    if (publishNow) {
      await enqueuePublish(postId);
    }

    return requirePost(businessId, postId);
  }

  async function cancel(businessId: string, postId: string) {
    const post = await requirePost(businessId, postId);

    if (["PUBLISHED", "PARTIALLY_PUBLISHED", "CANCELED", "PUBLISHING"].includes(post.status)) {
      throw new AppError(409, "POST_NOT_CANCELABLE", "This post can no longer be canceled", {
        status: post.status,
      });
    }

    await deps.prisma.$transaction([
      deps.prisma.post.update({
        where: { id: postId },
        data: { status: "CANCELED" },
      }),
      deps.prisma.postTarget.updateMany({
        where: { postId, status: { in: ["QUEUED", "PUBLISHING"] } },
        data: { status: "CANCELED" },
      }),
    ]);

    if (post.quotaConsumedAt) {
      await deps.quota.refund(businessId, post.format === "REEL" ? "REEL" : "POST");
      await deps.prisma.post.update({
        where: { id: postId },
        data: { quotaConsumedAt: null },
      });
    }

    return requirePost(businessId, postId);
  }

  async function enqueuePublish(postId: string) {
    await deps.prisma.outboxEvent.create({
      data: {
        type: "post.publish",
        payload: { postId },
      },
    });
  }

  async function publishTargets(postId: string): Promise<void> {
    const post = await deps.prisma.post.findUnique({
      where: { id: postId },
      include: {
        creatives: { orderBy: { version: "desc" }, take: 1 },
        targets: { include: { socialAccount: true } },
        business: true,
      },
    });

    if (!post) {
      return;
    }

    if (!["PUBLISHING", "SCHEDULED", "PARTIALLY_PUBLISHED"].includes(post.status)) {
      return;
    }

    const creative = post.creatives[0];

    if (!creative) {
      await deps.prisma.post.update({
        where: { id: postId },
        data: { status: "FAILED", failureCode: "CREATIVE_MISSING" },
      });

      return;
    }

    await deps.prisma.post.update({
      where: { id: postId },
      data: { status: "PUBLISHING" },
    });

    const asset = creative.assetId
      ? await deps.prisma.asset.findUnique({ where: { id: creative.assetId } })
      : null;
    const imageUrl = asset ? await deps.assets.urlFor(asset) : null;

    for (const target of post.targets) {
      if (target.status !== "QUEUED" && target.status !== "FAILED") {
        continue;
      }

      if (target.attempts >= 3) {
        continue;
      }

      const account = target.socialAccount;

      if (account.status !== "ACTIVE") {
        await deps.prisma.postTarget.update({
          where: { id: target.id },
          data: {
            status: "FAILED",
            errorCode: "ACCOUNT_NEEDS_REAUTH",
            errorDetail: "The connected account needs to be reconnected",
          },
        });
        continue;
      }

      await deps.prisma.postTarget.update({
        where: { id: target.id },
        data: { status: "PUBLISHING", attempts: { increment: 1 } },
      });

      try {
        const decrypted = await deps.connections.getDecrypted(account.id);
        const result = await deps.publishers[account.platform].publish({
          platform: account.platform,
          externalId: account.externalId,
          accessToken: decrypted.accessToken,
          caption: creative.caption,
          imageUrl,
          format: post.format,
          containerId: target.providerContainerId,
          meta: (account.meta ?? null) as Record<string, unknown> | null,
        });

        if (result.status === "PUBLISHED") {
          await deps.prisma.postTarget.update({
            where: { id: target.id },
            data: {
              status: "PUBLISHED",
              externalPostId: result.externalPostId,
              externalUrl: result.externalUrl,
              publishedAt: now(),
              errorCode: null,
              errorDetail: null,
            },
          });
        } else if (result.status === "PROCESSING") {
          await deps.prisma.postTarget.update({
            where: { id: target.id },
            data: {
              status: "QUEUED",
              providerContainerId: result.containerId,
              nextAttemptAt: new Date(now().getTime() + 30_000),
            },
          });
        } else if (result.status === "LIMIT") {
          await deps.prisma.postTarget.update({
            where: { id: target.id },
            data: {
              status: "QUEUED",
              errorCode: "PROVIDER_LIMIT",
              errorDetail: result.detail,
              nextAttemptAt: new Date(now().getTime() + result.retryAfterSec * 1000),
            },
          });
        } else if (result.status === "RETRYABLE") {
          await deps.prisma.postTarget.update({
            where: { id: target.id },
            data: {
              status: "QUEUED",
              errorCode: "RETRYABLE",
              errorDetail: result.detail,
              nextAttemptAt: new Date(now().getTime() + 60_000 * target.attempts),
            },
          });
        } else {
          await deps.prisma.postTarget.update({
            where: { id: target.id },
            data: {
              status: "FAILED",
              errorCode: result.status,
              errorDetail: result.detail,
            },
          });
        }
      } catch (error) {
        await deps.prisma.postTarget.update({
          where: { id: target.id },
          data: {
            status: "QUEUED",
            errorCode: "PUBLISH_ERROR",
            errorDetail: error instanceof Error ? error.message.slice(0, 500) : "Publish failed",
            nextAttemptAt: new Date(now().getTime() + 60_000 * target.attempts),
          },
        });
      }
    }

    await finalize(postId);
  }

  async function finalize(postId: string) {
    const post = await deps.prisma.post.findUnique({
      where: { id: postId },
      include: { targets: true, business: true },
    });

    if (!post) {
      return;
    }

    const published = post.targets.filter((target) => target.status === "PUBLISHED").length;
    const failed = post.targets.filter((target) => target.status === "FAILED").length;
    const active = post.targets.filter(
      (target) => target.status === "QUEUED" || target.status === "PUBLISHING",
    ).length;

    if (active > 0) {
      return;
    }

    if (published === post.targets.length) {
      await deps.prisma.post.update({
        where: { id: postId },
        data: { status: "PUBLISHED", publishedAt: now(), failureCode: null },
      });
      await deps.notifications.notify({
        userId: post.business.ownerId,
        businessId: post.businessId,
        type: "POST_PUBLISHED",
        titleNe: "à¤ªà¥‹à¤¸à¥à¤Ÿ à¤ªà¥à¤°à¤•à¤¾à¤¶à¤¿à¤¤ à¤­à¤¯à¥‹",
        titleEn: "Post published",
        bodyNe: `"${post.title}" à¤¸à¤«à¤²à¤¤à¤¾à¤ªà¥‚à¤°à¥à¤µà¤• à¤ªà¥à¤°à¤•à¤¾à¤¶à¤¿à¤¤ à¤­à¤¯à¥‹à¥¤`,
        bodyEn: `"${post.title}" was published successfully.`,
        data: { postId },
        channels: ["IN_APP", "PUSH"],
        dedupeKey: `post-published:${postId}`,
      });
      await maybeAdvanceOnboarding(post.businessId);
    } else if (published > 0) {
      await deps.prisma.post.update({
        where: { id: postId },
        data: { status: "PARTIALLY_PUBLISHED", publishedAt: now() },
      });
    } else {
      await deps.prisma.post.update({
        where: { id: postId },
        data: { status: "FAILED", failureCode: "PUBLISH_FAILED" },
      });
    }

    if (failed > 0) {
      await deps.notifications.notify({
        userId: post.business.ownerId,
        businessId: post.businessId,
        type: "POST_FAILED",
        titleNe: "à¤ªà¥‹à¤¸à¥à¤Ÿ à¤ªà¥à¤°à¤•à¤¾à¤¶à¤¿à¤¤ à¤¹à¥à¤¨ à¤¸à¤•à¥‡à¤¨",
        titleEn: "Post could not be published",
        bodyNe: `"${post.title}" à¤ªà¥à¤°à¤•à¤¾à¤¶à¤¿à¤¤ à¤—à¤°à¥à¤¨ à¤¸à¤®à¤¸à¥à¤¯à¤¾ à¤­à¤¯à¥‹à¥¤ à¤ªà¥à¤¨: à¤ªà¥à¤°à¤¯à¤¾à¤¸ à¤—à¤°à¥à¤¨à¥à¤¹à¥‹à¤¸à¥à¥¤`,
        bodyEn: `"${post.title}" could not be published. Please retry.`,
        data: { postId },
        channels: ["IN_APP", "PUSH"],
        dedupeKey: `post-failed:${postId}:${failed}`,
      });
    }
  }

  async function dueScheduled(limit = 20) {
    return deps.prisma.post.findMany({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lte: now() },
        targets: { some: { status: "QUEUED" } },
      },
      select: { id: true },
      take: limit,
    });
  }

  async function retry(businessId: string, postId: string) {
    const post = await requirePost(businessId, postId);

    if (!["FAILED", "PARTIALLY_PUBLISHED", "ON_HOLD"].includes(post.status)) {
      throw new AppError(409, "POST_NOT_RETRYABLE", "This post cannot be retried", {
        status: post.status,
      });
    }

    await deps.prisma.postTarget.updateMany({
      where: { postId, status: { in: ["FAILED", "SKIPPED"] } },
      data: {
        status: "QUEUED",
        attempts: 0,
        errorCode: null,
        errorDetail: null,
        nextAttemptAt: null,
      },
    });
    await deps.prisma.post.update({
      where: { id: postId },
      data: { status: "PUBLISHING", failureCode: null },
    });
    await enqueuePublish(postId);

    return requirePost(businessId, postId);
  }

  async function maybeAdvanceOnboarding(businessId: string) {
    const business = await deps.prisma.business.findUnique({
      where: { id: businessId },
      select: { onboardingStep: true },
    });

    if (business?.onboardingStep !== "DONE") {
      const published = await deps.prisma.post.count({
        where: { businessId, status: { in: ["PUBLISHED", "PARTIALLY_PUBLISHED"] } },
      });

      if (published > 0) {
        await deps.prisma.business.update({
          where: { id: businessId },
          data: { onboardingStep: "DONE" },
        });
      }
    }
  }

  return {
    create,
    update,
    list,
    get: requirePost,
    submit,
    decide,
    cancel,
    retry,
    publishTargets,
    dueScheduled,
    enqueuePublish,
  };
}


