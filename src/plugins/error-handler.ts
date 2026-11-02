import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send(errorBody("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION_ERROR", "Request validation failed", error.validation));
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message, error.details));
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return reply
          .code(409)
          .send(
            errorBody("CONFLICT", "A record with these values already exists", error.meta?.target),
          );
      }

      if (error.code === "P2025") {
        return reply.code(404).send(errorBody("NOT_FOUND", "Resource not found"));
      }

      if (error.code === "P2003") {
        return reply
          .code(409)
          .send(errorBody("CONFLICT", "The request violates a database relationship constraint"));
      }
    }

    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    }

    return reply
      .code(statusCode)
      .send(
        errorBody(
          statusCode === 429
            ? "TOO_MANY_REQUESTS"
            : statusCode >= 500
              ? "INTERNAL_SERVER_ERROR"
              : "REQUEST_ERROR",
          statusCode >= 500 ? "Internal server error" : error.message,
        ),
      );
  });
}
