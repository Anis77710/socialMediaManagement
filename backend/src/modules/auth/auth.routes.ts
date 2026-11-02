import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { publicUserSchema } from "../../lib/schemas.js";
import { getCurrentUser } from "../users/user.service.js";
import {
  authResponseSchema,
  authTokensResponseSchema,
  loginSchema,
  refreshTokenSchema,
  registerSchema,
} from "./auth.schemas.js";
import { login, logout, refresh, register } from "./auth.service.js";

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/register",
    {
      schema: {
        tags: ["Auth"],
        summary: "Create an account",
        body: registerSchema,
        response: {
          201: z.object({ data: authResponseSchema }),
        },
      },
    },
    async (request, reply) => {
      const result = await register(app, request.body);
      return reply.code(201).send({ data: result });
    },
  );

  app.post(
    "/login",
    {
      schema: {
        tags: ["Auth"],
        summary: "Sign in with email and password",
        body: loginSchema,
        response: {
          200: z.object({ data: authResponseSchema }),
        },
      },
    },
    async (request) => {
      const result = await login(app, request.body);
      return { data: result };
    },
  );

  app.post(
    "/refresh",
    {
      schema: {
        tags: ["Auth"],
        summary: "Rotate a refresh token and issue a new access token",
        body: refreshTokenSchema,
        response: {
          200: z.object({ data: authTokensResponseSchema }),
        },
      },
    },
    async (request) => {
      const tokens = await refresh(app, request.body);
      return { data: tokens };
    },
  );

  app.post(
    "/logout",
    {
      schema: {
        tags: ["Auth"],
        summary: "Revoke a refresh token",
        body: refreshTokenSchema,
        response: {
          204: z.null(),
        },
      },
    },
    async (request, reply) => {
      await logout(app, request.body);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/me",
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ["Auth"],
        summary: "Get the authenticated user",
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
};
