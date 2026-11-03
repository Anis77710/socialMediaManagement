import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { StaffRole } from "../../lib/permissions.js";
import type { StaffRecord, StaffRepo, StaffStatus } from "./staff.types.js";

type StaffRow = Omit<StaffRecord, "role" | "status"> & {
  role: string;
  status: string;
};

function mapStaff(row: StaffRow): StaffRecord {
  return {
    ...row,
    role: row.role as StaffRole,
    status: row.status as StaffStatus,
  };
}

export function createStaffRepo(prisma: PrismaClient): StaffRepo {
  return {
    async findStaffByEmail(email) {
      const row = await prisma.staffUser.findUnique({ where: { email } });

      return row ? mapStaff(row) : null;
    },

    async findStaffById(id) {
      const row = await prisma.staffUser.findUnique({ where: { id } });

      return row ? mapStaff(row) : null;
    },

    async createStaff(input) {
      const row = await prisma.staffUser.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          status: input.status ?? "INVITED",
          createdById: input.createdById ?? null,
        },
      });

      return mapStaff(row);
    },

    async updateStaff(id, data) {
      const row = await prisma.staffUser.update({ where: { id }, data });

      return mapStaff(row);
    },

    async listStaff({ page, limit, search, role, status }) {
      const where: Prisma.StaffUserWhereInput = {
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
        ...(search
          ? {
              OR: [
                { email: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.staffUser.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.staffUser.count({ where }),
      ]);

      return { rows: rows.map(mapStaff), total };
    },

    async listSuperAdmins() {
      const rows = await prisma.staffUser.findMany({
        where: { role: "SUPER_ADMIN", status: "ACTIVE" },
      });

      return rows.map(mapStaff);
    },

    countActiveSuperAdmins(exceptId) {
      return prisma.staffUser.count({
        where: {
          role: "SUPER_ADMIN",
          status: "ACTIVE",
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
      });
    },

    async incrementFailedLogins(id) {
      const staff = await prisma.staffUser.update({
        where: { id },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });

      return staff.failedLogins;
    },

    async resetFailedLogins(id, at, ip) {
      await prisma.staffUser.update({
        where: { id },
        data: {
          failedLogins: 0,
          lockedUntil: null,
          lastLoginAt: at,
          lastLoginIp: ip,
        },
      });
    },

    createInvite(input) {
      return prisma.staffInvite.create({ data: input });
    },

    findInviteByTokenHash(tokenHash) {
      return prisma.staffInvite.findUnique({ where: { tokenHash } });
    },

    async acceptInvite(id, at) {
      const result = await prisma.staffInvite.updateMany({
        where: { id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: at },
      });

      return result.count > 0;
    },

    async revokePendingInvites(email, at) {
      await prisma.staffInvite.updateMany({
        where: { email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: at },
      });
    },

    createPasswordReset(input) {
      return prisma.staffPasswordReset.create({ data: input });
    },

    findPasswordResetByTokenHash(tokenHash) {
      return prisma.staffPasswordReset.findUnique({ where: { tokenHash } });
    },

    async usePasswordReset(id, at) {
      const result = await prisma.staffPasswordReset.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: at },
      });

      return result.count > 0;
    },

    createStaffSession(input) {
      return prisma.staffSession.create({ data: input });
    },

    findStaffSessionByTokenHash(tokenHash) {
      return prisma.staffSession.findUnique({ where: { tokenHash } });
    },

    findStaffSessionById(id) {
      return prisma.staffSession.findUnique({ where: { id } });
    },

    async updateStaffSession(id, data) {
      await prisma.staffSession.update({ where: { id }, data });
    },

    async revokeStaffSession(id, reason, at) {
      await prisma.staffSession.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: at, revokeReason: reason },
      });
    },

    async revokeAllStaffSessions(staffId, reason, at, exceptSessionId) {
      const sessions = await prisma.staffSession.findMany({
        where: {
          staffId,
          revokedAt: null,
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        select: { id: true },
      });

      await prisma.staffSession.updateMany({
        where: {
          staffId,
          revokedAt: null,
          ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
        },
        data: { revokedAt: at, revokeReason: reason },
      });

      return sessions.map((session) => session.id);
    },

    listActiveStaffSessions(staffId, now) {
      return prisma.staffSession.findMany({
        where: {
          staffId,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    countActiveStaffSessions(staffId, now) {
      return prisma.staffSession.count({
        where: {
          staffId,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
      });
    },

    oldestActiveStaffSession(staffId, now) {
      return prisma.staffSession.findFirst({
        where: {
          staffId,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        orderBy: { createdAt: "asc" },
      });
    },

    async recordLoginAttempt(input) {
      await prisma.staffLoginAttempt.create({
        data: {
          emailHash: input.emailHash,
          ip: input.ip,
          success: input.success,
          reason: input.reason ?? null,
          ...(input.at ? { at: input.at } : {}),
        },
      });
    },

    countLoginFailuresSince(emailHash, since) {
      return prisma.staffLoginAttempt.count({
        where: { emailHash, success: false, at: { gte: since } },
      });
    },

    findCustomer(id) {
      return prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, phoneE164: true, status: true },
      });
    },

    async createSecurityEvent(input) {
      await prisma.securityEvent.create({
        data: {
          type: input.type,
          userId: input.userId,
          ip: input.ip,
          userAgent: input.userAgent,
          result: input.result,
          meta: input.meta as Prisma.InputJsonValue | undefined,
        },
      });
    },
  };
}
