import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema } from "../../lib/pagination.js";
import { idParamsSchema, mediaSchema, paginationMetaSchema } from "../../lib/schemas.js";
import { createMediaSchema } from "./media.schemas.js";
import { createMedia, deleteMedia, getMedia, listMedia } from "./media.service.js";

export const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      schema: {
        tags: ["Media"],
        summary: "List media metadata",
        security: [{ bearerAuth: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: z.object({
            data: z.array(mediaSchema),
            meta: paginationMetaSchema,
          }),
        },
      },
    },
    async (request) => {
      const result = await listMedia(app, request.user.sub, request.query);
      return {
        data: result.media,
        meta: result.meta,
      };
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["Media"],
        summary: "Get media metadata",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          200: z.object({ data: mediaSchema }),
        },
      },
    },
    async (request) => {
      const media = await getMedia(app, request.user.sub, request.params.id);
      return { data: media };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Media"],
        summary: "Register uploaded media metadata",
        security: [{ bearerAuth: [] }],
        body: createMediaSchema,
        response: {
          201: z.object({ data: mediaSchema }),
        },
      },
    },
    async (request, reply) => {
      const media = await createMedia(app, request.user.sub, request.body);
      return reply.code(201).send({ data: media });
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["Media"],
        summary: "Delete media metadata",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          204: z.null(),
        },
      },
    },
    async (request, reply) => {
      await deleteMedia(app, request.user.sub, request.params.id);
      return reply.code(204).send(null);
    },
  );
};
