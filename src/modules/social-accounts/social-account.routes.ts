import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { idParamsSchema, publicSocialAccountSchema } from "../../lib/schemas.js";
import {
  createSocialAccountSchema,
  listSocialAccountsQuerySchema,
  updateSocialAccountSchema,
} from "./social-account.schemas.js";
import {
  createSocialAccount,
  deleteSocialAccount,
  getSocialAccount,
  listSocialAccounts,
  updateSocialAccount,
} from "./social-account.service.js";

export const socialAccountRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      schema: {
        tags: ["Social accounts"],
        summary: "List connected social accounts",
        security: [{ bearerAuth: [] }],
        querystring: listSocialAccountsQuerySchema,
        response: {
          200: z.object({ data: z.array(publicSocialAccountSchema) }),
        },
      },
    },
    async (request) => {
      const accounts = await listSocialAccounts(app, request.user.sub, request.query);
      return { data: accounts };
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["Social accounts"],
        summary: "Get a connected social account",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          200: z.object({ data: publicSocialAccountSchema }),
        },
      },
    },
    async (request) => {
      const account = await getSocialAccount(app, request.user.sub, request.params.id);
      return { data: account };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Social accounts"],
        summary: "Connect a social account",
        security: [{ bearerAuth: [] }],
        body: createSocialAccountSchema,
        response: {
          201: z.object({ data: publicSocialAccountSchema }),
        },
      },
    },
    async (request, reply) => {
      const account = await createSocialAccount(app, request.user.sub, request.body);
      return reply.code(201).send({ data: account });
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["Social accounts"],
        summary: "Update a connected social account",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: updateSocialAccountSchema,
        response: {
          200: z.object({ data: publicSocialAccountSchema }),
        },
      },
    },
    async (request) => {
      const account = await updateSocialAccount(
        app,
        request.user.sub,
        request.params.id,
        request.body,
      );
      return { data: account };
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["Social accounts"],
        summary: "Disconnect a social account",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          204: z.null(),
        },
      },
    },
    async (request, reply) => {
      await deleteSocialAccount(app, request.user.sub, request.params.id);
      return reply.code(204).send(null);
    },
  );
};
