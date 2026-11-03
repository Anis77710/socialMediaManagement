import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import {
  UniqueConflictError,
  type AuthRepo,
  type CreateSessionInput,
  type DeviceInfo,
} from "./auth.types.js";

export function createAuthRepo(prisma: PrismaClient): AuthRepo {
  function mapUnique<T>(operation: Promise<T>): Promise<T> {
    return operation.catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new UniqueConflictError();
      }

      throw error;
    });
  }

  return {
    findUserByPhone(phoneE164) {
      return prisma.user.findUnique({ where: { phoneE164 } });
    },

    findUserByGoogleSub(googleSub) {
      return prisma.user.findUnique({ where: { googleSub } });
    },

    findUserById(id) {
      return prisma.user.findUnique({ where: { id } });
    },

    createUser(input) {
      return mapUnique(
        prisma.user.create({
          data: {
            phoneE164: input.phoneE164,
            phoneVerifiedAt: input.phoneVerifiedAt,
            googleSub: input.googleSub,
            email: input.email,
            name: input.name,
          },
        }),
      );
    },

    updateUser(id, data) {
      return mapUnique(prisma.user.update({ where: { id }, data }));
    },

    async incrementTokenVersion(id) {
      const user = await prisma.user.update({
        where: { id },
        data: { tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      });

      return user.tokenVersion;
    },

    createChallenge(input) {
      return prisma.otpChallenge.create({ data: input });
    },

    findChallenge(id) {
      return prisma.otpChallenge.findUnique({ where: { id } });
    },

    findLatestChallenge(phoneE164, purpose) {
      return prisma.otpChallenge.findFirst({
        where: { phoneE164, purpose },
        orderBy: { createdAt: "desc" },
      });
    },

    async incrementChallengeAttempts(id) {
      const challenge = await prisma.otpChallenge.update({
        where: { id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      return challenge.attempts;
    },

    async consumeChallenge(id, at) {
      await prisma.otpChallenge.update({ where: { id }, data: { consumedAt: at } });
    },

    createSession(input: CreateSessionInput) {
      return prisma.session.create({ data: input });
    },

    findSessionByTokenHash(tokenHash) {
      return prisma.session.findUnique({ where: { tokenHash } });
    },

    findSessionById(id) {
      return prisma.session.findUnique({ where: { id } });
    },

    async markSessionRotated(id, replacedById, rotatedAt) {
      const result = await prisma.session.updateMany({
        where: { id, rotatedAt: null, revokedAt: null },
        data: { replacedById, rotatedAt },
      });

      return result.count > 0;
    },

    async revokeSession(id, reason, at) {
      await prisma.session.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: at, revokeReason: reason },
      });
    },

    async revokeFamily(familyId, reason, at) {
      const sessions = await prisma.session.findMany({
        where: { familyId, revokedAt: null },
        select: { id: true },
      });

      await prisma.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: at, revokeReason: reason },
      });

      return sessions.map((session) => session.id);
    },

    async revokeAllSessions(userId, reason, at) {
      const sessions = await prisma.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at, revokeReason: reason },
      });

      return sessions.map((session) => session.id);
    },

    async listSessionIdsByFamily(familyId) {
      const sessions = await prisma.session.findMany({
        where: { familyId },
        select: { id: true },
      });

      return sessions.map((session) => session.id);
    },

    listActiveSessions(userId, now) {
      return prisma.session.findMany({
        where: {
          userId,
          revokedAt: null,
          replacedById: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    async countActiveFamilies(userId, now) {
      const families = await prisma.session.findMany({
        where: {
          userId,
          revokedAt: null,
          replacedById: null,
          expiresAt: { gt: now },
        },
        select: { familyId: true },
        distinct: ["familyId"],
      });

      return families.length;
    },

    async oldestActiveFamily(userId, now) {
      const session = await prisma.session.findFirst({
        where: {
          userId,
          revokedAt: null,
          replacedById: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "asc" },
        select: { familyId: true },
      });

      return session?.familyId ?? null;
    },

    async hasSeenDevice(userId, device: DeviceInfo) {
      const filters: Prisma.SessionWhereInput[] = [];

      if (device.name) {
        filters.push({ deviceName: device.name });
      }

      if (device.platform) {
        filters.push({ platform: device.platform });
      }

      if (filters.length === 0) {
        return false;
      }

      const session = await prisma.session.findFirst({
        where: {
          userId,
          revokedAt: null,
          OR: filters,
        },
        select: { id: true },
      });

      return session !== null;
    },

    async touchSession(id, at) {
      await prisma.session.update({ where: { id }, data: { lastUsedAt: at } });
    },

    async createConsents(input) {
      await prisma.consentRecord.createMany({
        data: [
          {
            userId: input.userId,
            document: "TERMS",
            version: input.termsVersion,
            acceptedAt: input.acceptedAt,
            ip: input.ip,
          },
          {
            userId: input.userId,
            document: "PRIVACY",
            version: input.privacyVersion,
            acceptedAt: input.acceptedAt,
            ip: input.ip,
          },
        ],
      });
    },

    async createSecurityEvent(event) {
      await prisma.securityEvent.create({
        data: {
          type: event.type,
          userId: event.userId,
          phoneHash: event.phoneHash,
          phoneMasked: event.phoneMasked,
          ip: event.ip,
          userAgent: event.userAgent,
          result: event.result,
          meta: event.meta as Prisma.InputJsonValue | undefined,
        },
      });
    },

    async isDenied(kind, value, now) {
      const entry = await prisma.denyListEntry.findFirst({
        where: {
          kind,
          value,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
      });

      return entry !== null;
    },

    async listActiveCidrs(now) {
      const entries = await prisma.denyListEntry.findMany({
        where: {
          kind: "CIDR",
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { value: true },
      });

      return entries.map((entry) => entry.value);
    },

    changePhone(userId, newPhone, keepFamilyId, reason, at) {
      return mapUnique(prisma.$transaction(async (transaction) => {
        await transaction.user.update({
          where: { id: userId },
          data: { phoneE164: newPhone, phoneVerifiedAt: at },
        });

        const sessions = await transaction.session.findMany({
          where: { userId, familyId: { not: keepFamilyId }, revokedAt: null },
          select: { id: true },
        });

        await transaction.session.updateMany({
          where: { userId, familyId: { not: keepFamilyId }, revokedAt: null },
          data: { revokedAt: at, revokeReason: reason },
        });

        return sessions.map((session) => session.id);
      }));
    },

    async linkGoogle(userId, googleSub, email) {
      await mapUnique(
        prisma.user.update({
          where: { id: userId },
          data: { googleSub, ...(email ? { email } : {}) },
        }),
      );
    },

    async unlinkGoogle(userId) {
      await prisma.user.update({
        where: { id: userId },
        data: { googleSub: null, email: null },
      });
    },

    async setDeletion(userId, requestedAt) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          status: requestedAt ? "DELETION_PENDING" : "ACTIVE",
          deletionRequestedAt: requestedAt,
        },
      });
    },
  };
}
