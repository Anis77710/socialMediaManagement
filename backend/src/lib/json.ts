import type { Prisma } from "../generated/prisma/client.js";

export function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
