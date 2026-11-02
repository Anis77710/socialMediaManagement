import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
  uptime: z.number(),
  timestamp: z.string(),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Liveness check",
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async () => {
      return {
        status: "ok" as const,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    },
  );

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness check",
        response: {
          200: z.object({ status: z.literal("ok") }),
          503: z.object({ status: z.literal("unavailable") }),
        },
      },
    },
    async (request, reply) => {
      try {
        await app.prisma.$queryRaw`SELECT 1`;
        return { status: "ok" as const };
      } catch (error) {
        request.log.error({ err: error }, "Database readiness check failed");
        return reply.code(503).send({ status: "unavailable" as const });
      }
    },
  );
};
