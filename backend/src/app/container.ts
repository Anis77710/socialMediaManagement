import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { createAiProviderFromEnv } from "../providers/ai/index.js";
import { createPaymentProvidersFromEnv } from "../providers/payments/index.js";
import { createPushProvider } from "../providers/push/index.js";
import { createRenderer } from "../providers/renderer/index.js";
import { createSocialPublishersFromEnv } from "../providers/social/index.js";
import { createStorageFromEnv } from "../providers/storage/index.js";
import { createAnalyticsService } from "../modules/analytics/analytics.service.js";
import { createAssetService } from "../modules/assets/asset.service.js";
import { createAutomationService } from "../modules/automation/automation.service.js";
import { createBillingService } from "../modules/billing/billing.service.js";
import { createQuotaService } from "../modules/billing/quota.service.js";
import { createBusinessService } from "../modules/business/business.service.js";
import { createConnectionService } from "../modules/connections/connection.service.js";
import { createContentService } from "../modules/creatives/content.service.js";
import { createNotificationService } from "../modules/notifications/notification.service.js";
import { createPostService } from "../modules/posts/post.service.js";
import { createSupportService } from "../modules/support/support.service.js";

export type AppServices = ReturnType<typeof createAppServices>;

export function createAppServices(app: FastifyInstance) {
  const storage = createStorageFromEnv(env);
  const renderer = createRenderer();
  const ai = createAiProviderFromEnv(env);
  const push = createPushProvider();
  const payments = createPaymentProvidersFromEnv(env);
  const publishers = createSocialPublishersFromEnv(env);
  const quota = createQuotaService(app.prisma);
  const assets = createAssetService({
    prisma: app.prisma,
    storage,
    maxBytes: env.MAX_UPLOAD_BYTES,
  });
  const notifications = createNotificationService({
    prisma: app.prisma,
    push,
    sms: app.smsSender,
  });
  const business = createBusinessService({ prisma: app.prisma, quota });
  const content = createContentService({ prisma: app.prisma, ai, env });
  const connections = createConnectionService({
    prisma: app.prisma,
    publishers,
    publicApiUrl: env.PUBLIC_API_URL,
  });
  const posts = createPostService({
    prisma: app.prisma,
    content,
    assets,
    quota,
    connections,
    notifications,
    renderer,
    publishers,
    reviewSlaHours: env.REVIEW_SLA_HOURS,
  });
  const billing = createBillingService({
    prisma: app.prisma,
    providers: payments,
    quota,
    assets,
    renderer,
    notifications,
    env,
  });
  const analytics = createAnalyticsService({
    prisma: app.prisma,
    connections,
    quota,
    publishers,
  });
  const automation = createAutomationService({ prisma: app.prisma, posts });
  const support = createSupportService({ prisma: app.prisma, assets });

  return {
    storage,
    renderer,
    ai,
    push,
    payments,
    publishers,
    quota,
    assets,
    notifications,
    business,
    content,
    connections,
    posts,
    billing,
    analytics,
    automation,
    support,
  };
}
