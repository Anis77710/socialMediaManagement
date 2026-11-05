import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fp from "fastify-plugin";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { env } from "../config/env.js";

export const swaggerPlugin = fp(
  async (app) => {
    if (!env.SWAGGER_ENABLED) {
      return;
    }

    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Redflie Business OS API",
          description:
            "Customer auth (phone OTP, Google, rotating refresh tokens), staff/admin auth (password + TOTP, opaque sessions, RBAC), social accounts, scheduled posts and media.",
          version: "0.1.0",
        },
        servers: [
          {
            url: `http://localhost:${env.PORT}`,
            description: "Local development",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
            cookieAuth: {
              type: "apiKey",
              in: "cookie",
              name: "__Host-rf_admin",
            },
          },
        },
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        deepLinking: true,
        docExpansion: "list",
      },
    });
  },
  {
    name: "swagger",
  },
);
