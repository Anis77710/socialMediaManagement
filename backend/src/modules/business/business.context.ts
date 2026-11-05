import type { FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors.js";
import type { AppServices } from "../../app/container.js";

export function businessIdFromRequest(request: FastifyRequest): string | null {
  const header = request.headers["x-business-id"];
  const value = Array.isArray(header) ? header[0] : header;

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function requireBusiness(
  request: FastifyRequest,
  services: AppServices,
) {
  if (!request.auth) {
    throw AppError.unauthorized();
  }

  return services.business.requireForUser(request.auth.userId, businessIdFromRequest(request));
}

export function requireOwner(
  request: FastifyRequest,
  business: { ownerId: string },
): void {
  if (!request.auth || request.auth.userId !== business.ownerId) {
    throw AppError.forbidden("Only the business owner can perform this action");
  }
}
