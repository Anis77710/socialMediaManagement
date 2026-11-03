import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";

const titles: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  errors?: unknown,
) {
  return reply
    .type("application/problem+json")
    .code(status)
    .send({
      type: "about:blank",
      title: titles[status] ?? (status >= 500 ? "Internal Server Error" : "Request Error"),
      status,
      code,
      detail,
      ...(errors === undefined ? {} : { errors }),
    });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return problem(
      reply,
      404,
      "NOT_FOUND",
      `Route ${request.method} ${request.url} not found`,
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return problem(reply, 400, "VALIDATION_ERROR", "Request validation failed", error.validation);
    }

    if (error instanceof AppError) {
      if (error.code === "AUTH_RATE_LIMITED") {
        const details = error.details as { retryAfterSec?: number } | undefined;

        if (details?.retryAfterSec) {
          reply.header("retry-after", String(details.retryAfterSec));
        }
      }

      return problem(reply, error.statusCode, error.code, error.message, error.details);
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return problem(
          reply,
          409,
          "CONFLICT",
          "A record with these values already exists",
          error.meta?.target,
        );
      }

      if (error.code === "P2025") {
        return problem(reply, 404, "NOT_FOUND", "Resource not found");
      }

      if (error.code === "P2003") {
        return problem(reply, 409, "CONFLICT", "The request violates a database relationship");
      }
    }

    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    }

    return problem(
      reply,
      statusCode,
      statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR",
      statusCode >= 500 ? "Internal server error" : error.message,
    );
  });
}
