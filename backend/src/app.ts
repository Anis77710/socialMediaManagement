import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { loggerOptions } from "./config/logger.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { authRoutes, publicAuthRoutes } from "./modules/auth/auth.routes.js";
import type { AuthRepo } from "./modules/auth/auth.types.js";
import type { RateLimiter } from "./lib/rate-limit.js";
import type { RevocationStore } from "./lib/revocations.js";
import type { GoogleVerifier } from "./providers/google.js";
import type { SmsSender } from "./providers/sms/types.js";
import type { CaptchaVerifier } from "./providers/turnstile.js";
import { adminPlugin, type AdminOverrides } from "./plugins/admin.js";
import { adminRoutes } from "./modules/staff/admin.routes.js";
import { authPlugin } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { redisPlugin } from "./plugins/redis.js";
import { securityPlugin } from "./plugins/security.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { apiRoutes } from "./routes/index.js";

export type AuthOverrides = {
  repo?: AuthRepo;
  limiter?: RateLimiter;
  revocations?: RevocationStore;
  sms?: SmsSender;
  google?: GoogleVerifier;
  captcha?: CaptchaVerifier;
  now?: () => Date;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
};

export type BuildAppOptions = {
  databaseUrl?: string;
  redisUrl?: string;
  useRedis?: boolean;
  runtimeRole?: "app-api" | "admin-api";
  auth?: AuthOverrides;
  admin?: AdminOverrides;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(env),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(cookie);
  await app.register(securityPlugin);
  await app.register(swaggerPlugin);
  await app.register(prismaPlugin, {
    ...(options.databaseUrl ? { databaseUrl: options.databaseUrl } : {}),
  });

  const useRedis = options.useRedis ?? env.NODE_ENV !== "test";

  if (useRedis) {
    await app.register(redisPlugin, {
      ...(options.redisUrl ? { redisUrl: options.redisUrl } : {}),
    });
  }

  await app.register(authPlugin, options.auth ?? {});

  const runtimeRole = options.runtimeRole ?? env.RUNTIME_ROLE;

  if (runtimeRole === "admin-api") {
    await app.register(adminPlugin, options.admin ?? {});
  }

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/v1/app/auth" });
  await app.register(publicAuthRoutes, { prefix: "/v1/public/auth" });
  await app.register(apiRoutes, { prefix: "/api/v1" });

  if (runtimeRole === "admin-api") {
    await app.register(adminRoutes, { prefix: "/v1/admin" });
  }

  return app;
}
