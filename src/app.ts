import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { authPlugin } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { securityPlugin } from "./plugins/security.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { apiRoutes } from "./routes/index.js";

export async function buildApp(): Promise<FastifyInstance> {
  const logger = {
    level: env.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie"],
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              ignore: "pid,hostname",
              translateTime: "SYS:standard",
            },
          },
        }
      : {}),
  };

  const app = Fastify({
    logger,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(securityPlugin);
  await app.register(swaggerPlugin);
  await app.register(prismaPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(apiRoutes, { prefix: "/api/v1" });

  return app;
}
