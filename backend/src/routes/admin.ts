import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { toJson } from "../lib/json.js";
import { idSchema } from "../lib/validation.js";

export const newAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/businesses",
    {
      preHandler: [app.requireStaff, app.requirePermission("users:read")],
      schema: {
        querystring: z.object({
          q: z.string().trim().max(100).optional(),
          status: z.string().max(30).optional(),
        }),
      },
    },
    async (request) => {
      const businesses = await app.prisma.business.findMany({
        where: {
          deletedAt: null,
          ...(request.query.status ? { status: request.query.status } : {}),
          ...(request.query.q
            ? { name: { contains: request.query.q, mode: "insensitive" } }
            : {}),
        },
        include: {
          owner: { select: { id: true, phoneE164: true, email: true } },
          subscription: { include: { plan: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });

      return { data: businesses };
    },
  );

  app.get(
    "/users",
    {
      preHandler: [app.requireStaff, app.requirePermission("users:read")],
      schema: {
        querystring: z.object({ q: z.string().trim().max(100).optional() }),
      },
    },
    async (request) => {
      const users = await app.prisma.user.findMany({
        where: request.query.q
          ? {
              OR: [
                { phoneE164: { contains: request.query.q } },
                { email: { contains: request.query.q, mode: "insensitive" } },
                { name: { contains: request.query.q, mode: "insensitive" } },
              ],
            }
          : undefined,
        select: {
          id: true,
          phoneE164: true,
          email: true,
          name: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });

      return { data: users };
    },
  );

  app.post(
    "/users/:id/suspend",
    {
      preHandler: [app.requireStaff, app.requirePermission("users:suspend")],
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ suspended: z.boolean(), reason: z.string().trim().max(500).optional() }),
      },
    },
    async (request) => {
      const user = await app.prisma.user.update({
        where: { id: request.params.id },
        data: { status: request.body.suspended ? "SUSPENDED" : "ACTIVE" },
      });
      await app.prisma.auditLog.create({
        data: {
          actorType: "STAFF",
          actorId: request.staff?.id ?? null,
          action: request.body.suspended ? "user.suspend" : "user.reactivate",
          entityType: "User",
          entityId: user.id,
          reason: request.body.reason ?? null,
          ip: request.ip,
          requestId: request.id,
        },
      });

      return { data: { id: user.id, status: user.status } };
    },
  );

  app.get(
    "/payments",
    {
      preHandler: [app.requireStaff, app.requirePermission("payments:read")],
      schema: {
        querystring: z.object({
          status: z.string().max(30).optional(),
          provider: z.string().max(30).optional(),
        }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.payment.findMany({
          where: {
            ...(request.query.status ? { status: request.query.status as never } : {}),
            ...(request.query.provider ? { provider: request.query.provider as never } : {}),
          },
          include: {
            plan: true,
            business: { select: { id: true, name: true } },
            proof: true,
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      };
    },
  );

  app.post(
    "/payments/:id/mark-paid",
    {
      preHandler: [app.requireStaff, app.requirePermission("payments:mark-paid")],
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
      },
    },
    async (request) => {
      const payment = await app.prisma.payment.findUnique({
        where: { id: request.params.id },
        include: { plan: true },
      });

      if (!payment) {
        throw AppError.notFound("Payment not found");
      }

      if (payment.status === "COMPLETED") {
        return { data: payment };
      }

      await app.services.billing.recordEvent(
        payment.id,
        payment.provider,
        "MANUAL_MARK_PAID",
        { staffId: request.staff?.id ?? null, reason: request.body.reason },
        true,
      );
      await app.services.billing.applyResult(payment.id, {
        status: "COMPLETED",
        providerRef: payment.providerRef ?? `manual-${payment.purchaseOrderId}`,
        providerTxnId: payment.providerTxnId ?? `manual-${payment.id}`,
        amountPaisa: payment.amountPaisa,
        raw: { manual: true, staffId: request.staff?.id ?? null },
        signatureValid: true,
      });

      return {
        data: await app.prisma.payment.findUnique({
          where: { id: payment.id },
          include: { plan: true, invoice: true },
        }),
      };
    },
  );

  app.get(
    "/bank-proofs",
    {
      preHandler: [app.requireStaff, app.requirePermission("payments:read")],
      schema: {
        querystring: z.object({ status: z.string().max(30).default("PENDING") }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.bankTransferProof.findMany({
          where: { status: request.query.status },
          include: { payment: { include: { plan: true, business: true } } },
          orderBy: { createdAt: "asc" },
          take: 100,
        }),
      };
    },
  );

  app.post(
    "/bank-proofs/:id/approve",
    {
      preHandler: [app.requireStaff, app.requirePermission("payments:mark-paid")],
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ note: z.string().trim().max(500).optional() }),
      },
    },
    async (request) => {
      const proof = await app.prisma.bankTransferProof.findUnique({
        where: { id: request.params.id },
        include: { payment: { include: { plan: true } } },
      });

      if (!proof) {
        throw AppError.notFound("Bank transfer proof not found");
      }

      await app.prisma.$transaction([
        app.prisma.bankTransferProof.update({
          where: { id: proof.id },
          data: {
            status: "APPROVED",
            reviewedById: request.staff?.id ?? null,
            reviewedAt: new Date(),
            reviewNote: request.body.note ?? null,
          },
        }),
      ]);
      await app.services.billing.recordEvent(
        proof.paymentId,
        "BANK_TRANSFER",
        "PROOF_APPROVED",
        { proofId: proof.id, staffId: request.staff?.id ?? null },
        true,
      );
      await app.services.billing.applyResult(proof.paymentId, {
        status: "COMPLETED",
        providerRef: proof.referenceNo,
        providerTxnId: proof.referenceNo,
        amountPaisa: proof.payment.amountPaisa,
        raw: { proofId: proof.id },
        signatureValid: true,
      });

      return { data: { ok: true } };
    },
  );

  app.post(
    "/bank-proofs/:id/reject",
    {
      preHandler: [app.requireStaff, app.requirePermission("payments:mark-paid")],
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({ note: z.string().trim().min(3).max(500) }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.bankTransferProof.update({
          where: { id: request.params.id },
          data: {
            status: "REJECTED",
            reviewedById: request.staff?.id ?? null,
            reviewedAt: new Date(),
            reviewNote: request.body.note,
          },
        }),
      };
    },
  );

  app.get(
    "/reviews",
    {
      preHandler: [app.requireStaff, app.requirePermission("reviews:work")],
      schema: {
        querystring: z.object({
          decision: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).default("PENDING"),
        }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.post.findMany({
          where: {
            status: "PENDING_APPROVAL",
            approvals: {
              some:
                request.query.decision === "ALL"
                  ? {}
                  : {
                      decision:
                        request.query.decision === "PENDING"
                          ? null
                          : request.query.decision,
                    },
            },
          },
          include: {
            business: { select: { id: true, name: true, townText: true } },
            creatives: { orderBy: { version: "desc" }, take: 1 },
            targets: { include: { socialAccount: true } },
          },
          orderBy: { createdAt: "asc" },
          take: 100,
        }),
      };
    },
  );

  app.get(
    "/tickets",
    {
      preHandler: [app.requireStaff, app.requirePermission("tickets:work")],
      schema: {
        querystring: z.object({
          status: z.string().max(30).optional(),
          assigned: z.enum(["me", "all"]).default("all"),
        }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.supportTicket.findMany({
          where: {
            ...(request.query.status ? { status: request.query.status } : {}),
            ...(request.query.assigned === "me"
              ? { assignedToId: request.staff?.id ?? "__none__" }
              : {}),
          },
          include: {
            business: { select: { id: true, name: true, ownerId: true } },
            messages: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { updatedAt: "asc" },
          take: 100,
        }),
      };
    },
  );

  app.post(
    "/tickets/:id/messages",
    {
      preHandler: [app.requireStaff, app.requirePermission("tickets:work")],
      schema: {
        params: z.object({ id: idSchema }),
        body: z.object({
          body: z.string().trim().min(1).max(5000),
          internal: z.boolean().default(false),
          status: z.string().max(30).optional(),
        }),
      },
    },
    async (request) => {
      const message = await app.prisma.$transaction(async (tx) => {
        const created = await tx.ticketMessage.create({
          data: {
            ticketId: request.params.id,
            authorType: "STAFF",
            authorId: request.staff?.id ?? "staff",
            body: request.body.body,
            internal: request.body.internal,
          },
        });
        await tx.supportTicket.update({
          where: { id: request.params.id },
          data: {
            ...(request.body.status ? { status: request.body.status } : {}),
            assignedToId: request.staff?.id ?? null,
          },
        });

        return created;
      });

      return { data: message };
    },
  );

  app.get(
    "/flags",
    {
      preHandler: [app.requireStaff, app.requirePermission("flags:write")],
    },
    async () => {
      return { data: await app.prisma.featureFlag.findMany({ orderBy: { key: "asc" } }) };
    },
  );

  app.put(
    "/flags/:key",
    {
      preHandler: [app.requireStaff, app.requirePermission("flags:write")],
      schema: {
        params: z.object({ key: z.string().trim().min(1).max(80) }),
        body: z.object({ enabled: z.boolean(), rollout: z.record(z.string(), z.unknown()).nullable().optional() }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.featureFlag.upsert({
          where: { key: request.params.key },
          create: {
            key: request.params.key,
            enabled: request.body.enabled,
            ...(request.body.rollout ? { rollout: toJson(request.body.rollout) } : {}),
          },
          update: {
            enabled: request.body.enabled,
            ...(request.body.rollout !== undefined
              ? {
                  rollout:
                    request.body.rollout === null
                      ? Prisma.JsonNull
                      : toJson(request.body.rollout),
                }
              : {}),
          },
        }),
      };
    },
  );

  app.get(
    "/settings",
    {
      preHandler: [app.requireStaff, app.requirePermission("settings:write")],
    },
    async () => {
      return { data: await app.prisma.systemSetting.findMany({ orderBy: { key: "asc" } }) };
    },
  );

  app.put(
    "/settings/:key",
    {
      preHandler: [app.requireStaff, app.requirePermission("settings:write")],
      schema: {
        params: z.object({ key: z.string().trim().min(1).max(80) }),
        body: z.object({ value: z.unknown() }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.systemSetting.upsert({
          where: { key: request.params.key },
          create: {
            key: request.params.key,
            value: request.body.value as object,
            updatedById: request.staff?.id ?? null,
          },
          update: {
            value: request.body.value as object,
            updatedById: request.staff?.id ?? null,
          },
        }),
      };
    },
  );

  app.get(
    "/audit",
    {
      preHandler: [app.requireStaff, app.requirePermission("audit:read")],
      schema: {
        querystring: z.object({
          entityType: z.string().max(60).optional(),
          entityId: z.string().max(80).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (request) => {
      return {
        data: await app.prisma.auditLog.findMany({
          where: {
            ...(request.query.entityType ? { entityType: request.query.entityType } : {}),
            ...(request.query.entityId ? { entityId: request.query.entityId } : {}),
          },
          orderBy: { at: "desc" },
          take: request.query.limit,
        }),
      };
    },
  );

  app.get(
    "/outbox",
    {
      preHandler: [app.requireStaff, app.requirePermission("ops:queues")],
    },
    async () => {
      const [pending, failed] = await Promise.all([
        app.prisma.outboxEvent.count({ where: { processedAt: null } }),
        app.prisma.outboxEvent.count({
          where: { processedAt: null, attempts: { gte: 5 } },
        }),
      ]);

      return { data: { pending, failed } };
    },
  );
};

