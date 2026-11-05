import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { toJson } from "../lib/json.js";
import { platformSchema } from "../lib/validation.js";
import { startOfNptDay } from "../lib/nepali.js";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

type UploadVerifier = {
  verifyUpload(key: string, expires: string, signature: string): boolean;
};

function uploadVerifier(storage: unknown): UploadVerifier | null {
  if (
    typeof storage === "object" &&
    storage !== null &&
    "verifyUpload" in storage &&
    typeof (storage as UploadVerifier).verifyUpload === "function"
  ) {
    return storage as UploadVerifier;
  }

  return null;
}

export const publicRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/plans", async () => {
    return { data: await app.services.billing.plans() };
  });

  app.get("/business-categories", async () => {
    return { data: await app.services.business.listCategories() };
  });

  app.get(
    "/towns",
    {
      schema: {
        querystring: z.object({ q: z.string().trim().max(80).optional() }),
      },
    },
    async (request) => {
      return { data: await app.services.business.searchTowns(request.query.q ?? "") };
    },
  );

  app.get(
    "/festivals",
    {
      schema: {
        querystring: z.object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      },
    },
    async (request) => {
      const from = request.query.from ?? startOfNptDay(new Date());
      const to = request.query.to ?? new Date(Date.now() + 90 * 86_400_000);

      return {
        data: await app.prisma.festival.findMany({
          where: { published: true, adDate: { gte: from, lte: to } },
          orderBy: { adDate: "asc" },
          take: 100,
        }),
      };
    },
  );

  app.get(
    "/media/*",
    async (request, reply) => {
      const key = (request.params as { "*": string })["*"];

      if (!key) {
        throw AppError.notFound("Media not found");
      }

      const asset = await app.prisma.asset.findUnique({ where: { storageKey: key } });

      if (!asset) {
        throw AppError.notFound("Media not found");
      }

      const query = request.query as { expires?: string; signature?: string };
      const storage = app.services.storage;

      if (!asset.isPublic) {
        const verifier = uploadVerifier(storage);

        if (
          !verifier ||
          !query.expires ||
          !query.signature ||
          !verifier.verifyUpload(key, query.expires, query.signature)
        ) {
          throw AppError.unauthorized("A valid media signature is required");
        }
      }

      const body = await storage.get(key);

      return reply
        .header("Content-Type", asset.mime)
        .header("Cache-Control", asset.isPublic ? "public, max-age=31536000, immutable" : "private, max-age=900")
        .send(body);
    },
  );

  app.put(
    "/storage/*",
    async (request, reply) => {
      const key = (request.params as { "*": string })["*"];
      const query = request.query as { expires?: string; signature?: string };
      const storage = app.services.storage;
      const verifier = uploadVerifier(storage);

      if (
        !key ||
        !verifier ||
        !query.expires ||
        !query.signature ||
        !verifier.verifyUpload(key, query.expires, query.signature)
      ) {
        throw AppError.unauthorized("The upload signature is invalid or expired");
      }

      const body = request.body;

      if (!Buffer.isBuffer(body)) {
        throw new AppError(400, "INVALID_UPLOAD", "Upload a binary body");
      }

      if (body.length > env.MAX_UPLOAD_BYTES) {
        throw new AppError(413, "FILE_TOO_LARGE", "The uploaded file is too large");
      }

      await storage.put(key, body, request.headers["content-type"] ?? "application/octet-stream");

      return reply.code(204).send();
    },
  );

  app.get(
    "/oauth/:platform/callback",
    {
      schema: {
        params: z.object({ platform: platformSchema }),
        querystring: z.object({
          code: z.string().min(1),
          state: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const result = await app.services.connections.completeOAuth({
        platform: request.params.platform,
        code: request.query.code,
        state: request.query.state,
      });
      const redirect = new URL(result.returnTo);
      redirect.searchParams.set("connected", "1");
      redirect.searchParams.set("accounts", String(result.accounts.length));

      return reply.redirect(redirect.toString());
    },
  );

  app.get(
    "/payments/:provider/callback",
    {
      schema: {
        params: z.object({ provider: z.enum(["esewa", "khalti"]) }),
      },
    },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const provider = request.params.provider.toUpperCase() as "ESEWA" | "KHALTI";
      const result = await app.services.billing.handleCallback(provider, query);
      const redirect = new URL(result.returnTo);
      redirect.searchParams.set("status", result.status);

      return reply.redirect(redirect.toString());
    },
  );

  app.post(
    "/webhooks/meta",
    async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"];
      const raw = JSON.stringify(request.body);
      const expected = `sha256=${createHmac("sha256", env.META_APP_SECRET ?? "")
        .update(raw)
        .digest("hex")}`;
      const valid =
        typeof signature === "string" && safeEqual(signature, expected);
      const payload = request.body as Record<string, unknown>;
      const externalId =
        typeof payload.id === "string" ? payload.id : null;

      if (externalId) {
        await app.prisma.webhookEvent.upsert({
          where: { provider_externalId: { provider: "META", externalId } },
          create: {
            provider: "META",
            externalId,
            payload: toJson(payload),
            signatureValid: valid,
          },
          update: { payload: toJson(payload), signatureValid: valid },
        });
      }

      if (!valid) {
        throw AppError.unauthorized("Invalid webhook signature");
      }

      return reply.code(200).send({ received: true });
    },
  );

  app.get(
    "/webhooks/meta",
    {
      schema: {
        querystring: z.object({
          "hub.mode": z.string().optional(),
          "hub.verify_token": z.string().optional(),
          "hub.challenge": z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      if (
        request.query["hub.mode"] === "subscribe" &&
        request.query["hub.verify_token"] === env.META_WEBHOOK_VERIFY_TOKEN
      ) {
        return reply.code(200).send(request.query["hub.challenge"] ?? "");
      }

      throw AppError.forbidden("Webhook verification failed");
    },
  );
};

