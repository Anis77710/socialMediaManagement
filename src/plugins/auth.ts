import jwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

export const authPlugin = fp(
  async (app) => {
    await app.register(jwt, {
      secret: env.JWT_SECRET,
      sign: {
        expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      },
    });

    app.decorate(
      "authenticate",
      async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        try {
          await request.jwtVerify();
        } catch {
          throw AppError.unauthorized();
        }
      },
    );
  },
  {
    name: "auth",
  },
);
