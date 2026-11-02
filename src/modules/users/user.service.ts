import type { FastifyInstance } from "fastify";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { PublicUser } from "../../lib/selects.js";
import { publicUserSelect } from "../../lib/selects.js";
import type { UpdateProfileInput } from "./user.schemas.js";

export async function getCurrentUser(app: FastifyInstance, userId: string): Promise<PublicUser> {
  const user = await app.prisma.user.findUnique({
    where: { id: userId },
    select: publicUserSelect,
  });

  if (!user) {
    throw AppError.unauthorized("User no longer exists");
  }

  return user;
}

export async function updateProfile(
  app: FastifyInstance,
  userId: string,
  input: UpdateProfileInput,
): Promise<PublicUser> {
  const data: Prisma.UserUpdateInput = {};

  if (input.name !== undefined) {
    data.name = input.name;
  }

  if (input.avatarUrl !== undefined) {
    data.avatarUrl = input.avatarUrl;
  }

  return app.prisma.user.update({
    where: { id: userId },
    data,
    select: publicUserSelect,
  });
}
