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
          title: "Social Media Management API",
          description: "REST API for managing social accounts, scheduled posts, and media.",
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
