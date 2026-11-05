import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import {
  autonomyModeSchema,
  cursorQuerySchema,
  dateTimeSchema,
  idSchema,
  languageSchema,
  platformSchema,
  urlSchema,
} from "../lib/validation.js";
import { acceptLanguage } from "../lib/validation.js";
import {
  businessIdFromRequest,
  requireBusiness,
  requireOwner,
} from "../modules/business/business.context.js";

const postFormatSchema = z.enum(["IMAGE", "REEL"]);
const postStatusSchema = z.enum([
  "DRAFT",
  "IN_REVIEW",
  "PENDING_APPROVAL",
  "READY",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "PARTIALLY_PUBLISHED",
  "FAILED",
  "REJECTED",
  "CANCELED",
  "ON_HOLD",
  "EXPIRED",
]);

export const appRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/me", async (request) => {
    const userId = request.auth!.userId;
    const [user, businesses] = await Promise.all([
      app.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          phoneE164: true,
          email: true,
          name: true,
          locale: true,
          avatarUrl: true,
          status: true,
          createdAt: true,
        },
      }),
      app.prisma.business.findMany({
        where: {
          deletedAt: null,
          OR: [{ ownerId: userId }, { members: { some: { userId } } }],
        },
        select: {
          id: true,
          name: true,
          townText: true,
          categoryId: true,
          onboardingStep: true,
          autonomyMode: true,
          logoAssetId: true,
        },
      }),
    ]);

    if (!user) {
      throw AppError.notFound("User not found");
    }

    return { data: { user, businesses } };
  });

  app.patch(
    "/me",
    {
      schema: {
        body: z.object({
          name: z.string().trim().min(2).max(120).optional(),
          email: z.email().nullable().optional(),
          locale: languageSchema.optional(),
        }),
      },
    },
    async (request) => {
      const body = request.body;
      const user = await app.prisma.user.update({
        where: { id: request.auth!.userId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
        },
        select: {
          id: true,
          phoneE164: true,
          email: true,
          name: true,
          locale: true,
          avatarUrl: true,
        },
      });

      return { data: user };
    },
  );

  app.get("/business", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: business };
  });

  app.post(
    "/business",
    {
      schema: {
        body: z.object({
          name: z.string().trim().min(2).max(120),
          categoryId: z.string().trim().min(1).max(64),
          townId: z.string().trim().min(1).max(64).nullable().optional(),
          townText: z.string().trim().min(1).max(120),
          customerPhone: z.string().trim().max(20).nullable().optional(),
          language: languageSchema.default("NE"),
          panNumber: z.string().trim().max(30).nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const business = await app.services.business.create(request.auth!.userId, request.body);

      return reply.code(201).send({ data: business });
    },
  );

  app.patch(
    "/business",
    {
      schema: {
        body: z.object({
          name: z.string().trim().min(2).max(120).optional(),
          categoryId: z.string().trim().min(1).max(64).optional(),
          townId: z.string().trim().min(1).max(64).nullable().optional(),
          townText: z.string().trim().min(1).max(120).optional(),
          customerPhone: z.string().trim().max(20).nullable().optional(),
          language: languageSchema.optional(),
          panNumber: z.string().trim().max(30).nullable().optional(),
          logoAssetId: z.string().trim().min(1).max(64).nullable().optional(),
          autonomyMode: autonomyModeSchema.optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);
      const updated = await app.services.business.update(
        request.auth!.userId,
        business.id,
        request.body,
      );

      return { data: updated };
    },
  );

  app.get("/onboarding", async (request) => {
    const data = await app.services.business.onboarding(
      request.auth!.userId,
      businessIdFromRequest(request),
    );

    return { data };
  });

  app.get("/connections", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.connections.list(business.id) };
  });

  app.post(
    "/connections/:platform/oauth/start",
    {
      schema: {
        params: z.object({ platform: platformSchema }),
        body: z.object({
          returnTo: urlSchema.default("http://localhost:3001/connections"),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);
      const result = await app.services.connections.startOAuth({
        businessId: business.id,
        userId: request.auth!.userId,
        platform: request.params.platform,
        returnTo: request.body.returnTo,
      });

      return { data: result };
    },
  );

  app.delete(
    "/connections/:id",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);

      return { data: await app.services.connections.disconnect(business.id, request.params.id) };
    },
  );

  app.post(
    "/creatives/generate",
    {
      schema: {
        body: z.object({
          brief: z.string().trim().min(5).max(2000),
          language: languageSchema.default("NE"),
          format: postFormatSchema.default("IMAGE"),
          occasion: z.string().trim().max(120).nullable().optional(),
          templateKey: z.string().trim().max(64).optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      const generated = await app.services.content.generate({
        business,
        brief: request.body.brief,
        language: request.body.language,
        occasion: request.body.occasion ?? null,
        ...(request.body.templateKey ? { templateKey: request.body.templateKey } : {}),
      });

      return { data: generated };
    },
  );

  app.get("/creatives/templates", async (request) => {
    const business = await requireBusiness(request, app.services);
    const [templates, posters, glossary] = await Promise.all([
      app.services.content.templates(),
      app.services.content.posterTemplates(),
      app.services.content.glossary(business.language),
    ]);

    return { data: { templates, posters, glossary } };
  });

  app.get("/creatives/suggestions", async (request) => {
    const business = await requireBusiness(request, app.services);

    return {
      data: await app.services.content.suggestions(
        business.id,
        business.categoryId,
        8,
      ),
    };
  });

  app.get(
    "/posts",
    {
      schema: {
        querystring: cursorQuerySchema.extend({
          status: postStatusSchema.optional(),
          format: postFormatSchema.optional(),
          from: dateTimeSchema.optional(),
          to: dateTimeSchema.optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      const data = await app.services.posts.list(business.id, request.query);

      return { data: data.items, meta: { nextCursor: data.nextCursor } };
    },
  );

  app.get(
    "/posts/:id",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return { data: await app.services.posts.get(business.id, request.params.id) };
    },
  );

  app.post(
    "/posts",
    {
      schema: {
        body: z.object({
          brief: z.string().trim().min(5).max(2000),
          title: z.string().trim().max(120).optional(),
          format: postFormatSchema.default("IMAGE"),
          language: languageSchema.default("NE"),
          occasion: z.string().trim().max(120).nullable().optional(),
          socialAccountIds: z.array(idSchema).min(1).max(10),
          festivalId: z.string().trim().max(64).nullable().optional(),
          templateKey: z.string().trim().max(64).optional(),
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      const post = await app.services.posts.create({
        business,
        userId: request.auth!.userId,
        format: request.body.format,
        ...(request.body.title ? { title: request.body.title } : {}),
        brief: request.body.brief,
        language: request.body.language,
        occasion: request.body.occasion ?? null,
        socialAccountIds: request.body.socialAccountIds,
        festivalId: request.body.festivalId ?? null,
        ...(request.body.templateKey ? { templateKey: request.body.templateKey } : {}),
      });

      return reply.code(201).send({ data: post });
    },
  );

  app.patch(
    "/posts/:id",
    {
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({
          brief: z.string().trim().min(5).max(2000).optional(),
          title: z.string().trim().max(120).optional(),
          format: postFormatSchema.optional(),
          language: languageSchema.optional(),
          occasion: z.string().trim().max(120).nullable().optional(),
          socialAccountIds: z.array(idSchema).min(1).max(10).optional(),
          templateKey: z.string().trim().max(64).optional(),
          caption: z.string().trim().max(2200).optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      const post = await app.services.posts.update(
        business.id,
        request.params.id,
        request.body,
      );

      return { data: post };
    },
  );

  app.post(
    "/posts/:id/submit",
    {
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({
          scheduledAt: dateTimeSchema.nullable().optional(),
          publishNow: z.boolean().default(false),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      const post = await app.services.posts.submit(business.id, request.params.id, {
        scheduledAt: request.body.scheduledAt ?? null,
        publishNow: request.body.publishNow,
        actor: request.auth!.userId === business.ownerId ? "OWNER" : "STAFF",
      });

      return { data: post };
    },
  );

  app.post(
    "/posts/:id/approve",
    {
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ feedback: z.string().trim().max(1000).optional() }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);

      return {
        data: await app.services.posts.decide(business.id, request.params.id, {
          decision: "APPROVED",
          userId: request.auth!.userId,
          ...(request.body.feedback ? { feedback: request.body.feedback } : {}),
        }),
      };
    },
  );

  app.post(
    "/posts/:id/reject",
    {
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ feedback: z.string().trim().min(2).max(1000) }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);

      return {
        data: await app.services.posts.decide(business.id, request.params.id, {
          decision: "REJECTED",
          userId: request.auth!.userId,
          feedback: request.body.feedback,
        }),
      };
    },
  );

  app.post(
    "/posts/:id/cancel",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return { data: await app.services.posts.cancel(business.id, request.params.id) };
    },
  );

  app.post(
    "/posts/:id/retry",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return { data: await app.services.posts.retry(business.id, request.params.id) };
    },
  );

  app.get(
    "/calendar",
    {
      schema: {
        querystring: z.object({
          from: dateTimeSchema.optional(),
          to: dateTimeSchema.optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      const from = request.query.from ?? new Date(Date.now() - 30 * 86_400_000);
      const to = request.query.to ?? new Date(Date.now() + 60 * 86_400_000);
      const posts = await app.prisma.post.findMany({
        where: {
          businessId: business.id,
          OR: [
            { scheduledAt: { gte: from, lte: to } },
            { publishedAt: { gte: from, lte: to } },
          ],
        },
        select: {
          id: true,
          title: true,
          format: true,
          status: true,
          scheduledAt: true,
          publishedAt: true,
        },
        orderBy: { scheduledAt: "asc" },
      });

      return { data: posts };
    },
  );

  app.get(
    "/assets",
    {
      schema: {
        querystring: z.object({ kind: z.string().max(40).optional() }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return { data: await app.services.assets.list(business.id, request.query.kind) };
    },
  );

  app.post(
    "/assets/upload",
    {
      schema: {
        querystring: z.object({
          kind: z.string().trim().min(1).max(40).default("image"),
          public: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      const file = await request.file();

      if (!file) {
        throw new AppError(400, "FILE_REQUIRED", "Upload a file");
      }

      const buffer = await file.toBuffer();
      const asset = await app.services.assets.upload({
        businessId: business.id,
        kind: request.query.kind,
        buffer,
        declaredMime: file.mimetype,
        isPublic: request.query.public,
      });

      return reply.code(201).send({ data: asset });
    },
  );

  app.post(
    "/assets/presign",
    {
      schema: {
        body: z.object({
          kind: z.string().trim().min(1).max(40),
          mime: z.string().trim().min(1).max(120),
          bytes: z.number().int().positive(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.assets.presign({
          businessId: business.id,
          ...request.body,
        }),
      };
    },
  );

  app.post(
    "/assets/complete",
    {
      schema: {
        body: z.object({
          key: z.string().trim().min(1).max(500),
          kind: z.string().trim().min(1).max(40),
          mime: z.string().trim().min(1).max(120),
          bytes: z.number().int().positive(),
          width: z.number().int().positive().nullable().optional(),
          height: z.number().int().positive().nullable().optional(),
          public: z.boolean().default(false),
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      const asset = await app.services.assets.complete({
        businessId: business.id,
        key: request.body.key,
        kind: request.body.kind,
        mime: request.body.mime,
        bytes: request.body.bytes,
        width: request.body.width ?? null,
        height: request.body.height ?? null,
        isPublic: request.body.public,
      });

      return reply.code(201).send({ data: asset });
    },
  );

  app.delete(
    "/assets/:id",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      await app.services.assets.remove(business.id, request.params.id);

      return { data: { ok: true } };
    },
  );

  app.get("/billing/subscription", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.billing.subscriptionView(business.id) };
  });

  app.get(
    "/billing/quote",
    {
      schema: { querystring: z.object({ planId: z.string().trim().min(1) }) },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.billing.upgradeQuote(business.id, request.query.planId),
      };
    },
  );

  app.post(
    "/billing/payments",
    {
      schema: {
        body: z.object({
          planId: z.string().trim().min(1),
          provider: z.enum(["ESEWA", "KHALTI"]),
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);
      const result = await app.services.billing.initiatePayment({
        businessId: business.id,
        planId: request.body.planId,
        provider: request.body.provider,
      });

      return reply.code(201).send({ data: result });
    },
  );

  app.post(
    "/billing/bank-transfer",
    {
      schema: { body: z.object({ planId: z.string().trim().min(1) }) },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);

      return reply.code(201).send({
        data: await app.services.billing.initiateBankTransfer({
          businessId: business.id,
          planId: request.body.planId,
        }),
      });
    },
  );

  app.post(
    "/billing/bank-transfer/:paymentId/proof",
    {
      schema: {
        params: z.object({ paymentId: idSchema }),
        body: z.object({
          assetId: idSchema,
          bankName: z.string().trim().min(2).max(120),
          referenceNo: z.string().trim().min(2).max(120),
          paidAt: dateTimeSchema,
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);

      return reply.code(201).send({
        data: await app.services.billing.submitBankProof({
          businessId: business.id,
          paymentId: request.params.paymentId,
          ...request.body,
        }),
      });
    },
  );

  app.get(
    "/billing/payments/:id",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.billing.checkStatus(business.id, request.params.id),
      };
    },
  );

  app.get("/billing/invoices", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.billing.invoices(business.id) };
  });

  app.get(
    "/billing/invoices/:id/pdf",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return { data: await app.services.billing.invoicePdf(business.id, request.params.id) };
    },
  );

  app.post("/billing/cancel", async (request) => {
    const business = await requireBusiness(request, app.services);
    requireOwner(request, business);

    return { data: await app.services.billing.cancel(business.id) };
  });

  app.post("/billing/resume", async (request) => {
    const business = await requireBusiness(request, app.services);
    requireOwner(request, business);

    return { data: await app.services.billing.resume(business.id) };
  });

  app.get(
    "/analytics/overview",
    {
      schema: {
        querystring: z.object({
          from: dateTimeSchema.optional(),
          to: dateTimeSchema.optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.analytics.overview(
          business.id,
          request.query.from,
          request.query.to,
        ),
      };
    },
  );

  app.get(
    "/analytics/posts",
    {
      schema: {
        querystring: z.object({
          from: dateTimeSchema.optional(),
          to: dateTimeSchema.optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.analytics.postPerformance(
          business.id,
          request.query.from,
          request.query.to,
        ),
      };
    },
  );

  app.get("/analytics/best-times", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.analytics.bestTimes(business.id) };
  });

  app.post(
    "/sales",
    {
      schema: {
        body: z.object({
          amountPaisa: z.number().int().positive(),
          occurredAt: dateTimeSchema,
          source: z.string().trim().max(40).optional(),
          note: z.string().trim().max(500).nullable().optional(),
          attributedPostId: z.string().trim().max(64).nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);
      const sale = await app.services.analytics.createSale({
        businessId: business.id,
        ...request.body,
      });

      return reply.code(201).send({ data: sale });
    },
  );

  app.get(
    "/sales",
    {
      schema: {
        querystring: z.object({
          from: dateTimeSchema.optional(),
          to: dateTimeSchema.optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.analytics.listSales(
          business.id,
          request.query.from,
          request.query.to,
        ),
      };
    },
  );

  app.get("/reports/weekly", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.analytics.listReports(business.id) };
  });

  app.post("/reports/weekly", async (request, reply) => {
    const business = await requireBusiness(request, app.services);

    return reply.code(201).send({
      data: await app.services.analytics.weeklyReport(business.id),
    });
  });

  app.get(
    "/notifications",
    {
      schema: {
        querystring: cursorQuerySchema.extend({
          unreadOnly: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
        }),
      },
    },
    async (request) => {
      const data = await app.services.notifications.list(request.auth!.userId, request.query);

      return { data: data.items, meta: { nextCursor: data.nextCursor } };
    },
  );

  app.post(
    "/notifications/read",
    {
      schema: { body: z.object({ ids: z.array(idSchema).min(1).max(100) }) },
    },
    async (request) => {
      const count = await app.services.notifications.markRead(
        request.auth!.userId,
        request.body.ids,
      );

      return { data: { updated: count } };
    },
  );

  app.get("/notifications/preferences", async (request) => {
    return { data: await app.services.notifications.getPreferences(request.auth!.userId) };
  });

  app.put(
    "/notifications/preferences",
    {
      schema: {
        body: z.object({
          channels: z.array(z.enum(["IN_APP", "PUSH", "SMS"])).min(1),
          quietHours: z.boolean(),
          language: languageSchema,
        }),
      },
    },
    async (request) => {
      return {
        data: await app.services.notifications.setPreferences(
          request.auth!.userId,
          request.body,
        ),
      };
    },
  );

  app.get("/automation", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.automation.get(business.id) };
  });

  app.put(
    "/automation",
    {
      schema: {
        body: z.object({
          maxPostsPerWeek: z.number().int().min(1).max(14).optional(),
          allowedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
          windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
          windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
          blockedKeywords: z.array(z.string().trim().max(60)).max(50).optional(),
          accountIds: z.array(idSchema).max(10).optional(),
          paused: z.boolean().optional(),
          pausedUntil: dateTimeSchema.nullable().optional(),
          adBudgetCapPaisa: z.number().int().nonnegative().optional(),
        }),
      },
    },
    async (request) => {
      const business = await requireBusiness(request, app.services);
      requireOwner(request, business);

      return {
        data: await app.services.automation.upsert(
          business.id,
          request.auth!.userId,
          request.body,
        ),
      };
    },
  );

  app.post("/automation/pause", async (request) => {
    const business = await requireBusiness(request, app.services);
    requireOwner(request, business);

    return {
      data: await app.services.automation.pause(business.id, request.auth!.userId),
    };
  });

  app.post("/automation/resume", async (request) => {
    const business = await requireBusiness(request, app.services);
    requireOwner(request, business);

    return {
      data: await app.services.automation.resume(business.id, request.auth!.userId),
    };
  });

  app.get("/automation/slots", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.automation.suggestSlots(business.id) };
  });

  app.get("/support/tickets", async (request) => {
    const business = await requireBusiness(request, app.services);

    return { data: await app.services.support.listTickets(business.id) };
  });

  app.post(
    "/support/tickets",
    {
      schema: {
        body: z.object({
          subject: z.string().trim().min(3).max(200),
          body: z.string().trim().min(3).max(5000),
          priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
        }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);

      return reply.code(201).send({
        data: await app.services.support.createTicket({
          businessId: business.id,
          userId: request.auth!.userId,
          ...request.body,
        }),
      });
    },
  );

  app.get(
    "/support/tickets/:id",
    { schema: { params: z.object({ id: idSchema }) } },
    async (request) => {
      const business = await requireBusiness(request, app.services);

      return {
        data: await app.services.support.getTicket(business.id, request.params.id),
      };
    },
  );

  app.post(
    "/support/tickets/:id/messages",
    {
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ body: z.string().trim().min(1).max(5000) }),
      },
    },
    async (request, reply) => {
      const business = await requireBusiness(request, app.services);

      return reply.code(201).send({
        data: await app.services.support.addMessage({
          businessId: business.id,
          ticketId: request.params.id,
          userId: request.auth!.userId,
          body: request.body.body,
        }),
      });
    },
  );

  app.get("/privacy/requests", async (request) => {
    return { data: await app.services.support.listDataRequests(request.auth!.userId) };
  });

  app.post(
    "/privacy/export",
    async (request, reply) => {
      return reply.code(201).send({
        data: await app.services.support.createDataRequest({
          userId: request.auth!.userId,
          kind: "EXPORT",
        }),
      });
    },
  );

  app.post("/privacy/delete", async (request, reply) => {
    return reply.code(201).send({
      data: await app.services.support.createDataRequest({
        userId: request.auth!.userId,
        kind: "DELETION",
      }),
    });
  });

  app.get("/config", async (request) => {
    const language = acceptLanguage(request.headers["accept-language"]);
    const business = await app.services.business.findForUser(
      request.auth!.userId,
      businessIdFromRequest(request),
    );
    const [plans, categories] = await Promise.all([
      app.services.billing.plans(),
      app.services.business.listCategories(),
    ]);

    return {
      data: {
        language,
        business,
        plans,
        categories,
        features: {
          autopilot: env.AUTOPILOT_ENABLED,
          aiWording: env.AI_WORDING_ENABLED,
          sampleData: env.SAMPLE_DATA_ENABLED,
        },
      },
    };
  });
};


