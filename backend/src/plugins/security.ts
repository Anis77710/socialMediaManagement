import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import { env } from "../config/env.js";

export const securityPlugin = fp(
  async (app) => {
    await app.register(cors, {
      origin: env.CORS_ORIGINS,
      credentials: true,
    });

    await app.register(helmet, {
      contentSecurityPolicy: false,
    });

    await app.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW,
    });
  },
  {
    name: "security",
  },
);
