import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { publicUserSchema } from "../../lib/schemas.js";
import { updateProfileSchema } from "./user.schemas.js";
import { getCurrentUser, updateProfile } from "./user.service.js";

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/me",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["Users"],
        summary: "Get the current user",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({ data: publicUserSchema }),
        },
      },
    },
    async (request) => {
      const user = await getCurrentUser(app, request.user.sub);
      return { data: user };
    },
  );

  app.patch(
    "/me",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["Users"],
        summary: "Update the current user",
        security: [{ bearerAuth: [] }],
        body: updateProfileSchema,
        response: {
          200: z.object({ data: publicUserSchema }),
        },
      },
    },
    async (request) => {
      const user = await updateProfile(app, request.user.sub, request.body);
      return { data: user };
    },
  );
};
