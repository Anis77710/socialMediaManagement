import { randomUUID } from "node:crypto";
import type {
  CreateStaffInput,
  CustomerSummary,
  LoginAttemptInput,
  StaffInviteRecord,
  StaffPasswordResetRecord,
  StaffRecord,
  StaffRepo,
  StaffSessionRecord,
  StaffSessionUpdate,
  StaffUpdate,
} from "../../src/modules/staff/staff.types.js";

export function createFakeStaffRepo(now: () => Date) {
  const staff = new Map<string, StaffRecord>();
  const invites = new Map<string, StaffInviteRecord>();
  const resets = new Map<string, StaffPasswordResetRecord>();
  const sessions = new Map<string, StaffSessionRecord>();
  const attempts: Array<LoginAttemptInput & { at: Date }> = [];
  const securityEvents: Array<Record<string, unknown>> = [];
  const customers = new Map<string, CustomerSummary>();

  function findByEmail(email: string): StaffRecord | null {
    return [...staff.values()].find((record) => record.email === email) ?? null;
  }

  function activeSessions(staffId: string, at: Date): StaffSessionRecord[] {
    return [...sessions.values()]
      .filter(
        (session) =>
          session.staffId === staffId &&
          !session.revokedAt &&
          session.idleExpiresAt > at &&
          session.absoluteExpiresAt > at,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  const repo: StaffRepo = {
    async findStaffByEmail(email) {
      return findByEmail(email);
    },

    async findStaffById(id) {
      return staff.get(id) ?? null;
    },

    async createStaff(input: CreateStaffInput) {
      const timestamp = now();
      const record: StaffRecord = {
        id: randomUUID(),
        email: input.email,
        name: input.name,
        role: input.role,
        status: input.status ?? "INVITED",
        passwordHash: null,
        passwordChangedAt: null,
        totpSecretEnc: null,
        totpLastStep: null,
        mfaEnabledAt: null,
        recoveryCodeHashes: [],
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: null,
        lastLoginIp: null,
        createdById: input.createdById ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      staff.set(record.id, record);

      return record;
    },

    async updateStaff(id, data: StaffUpdate) {
      const record = staff.get(id);

      if (!record) {
        throw new Error(`Staff ${id} not found`);
      }

      Object.assign(record, data, { updatedAt: now() });

      return record;
    },

    async listStaff(input) {
      const search = input.search?.toLowerCase();
      const rows = [...staff.values()]
        .filter((record) => (input.role ? record.role === input.role : true))
        .filter((record) => (input.status ? record.status === input.status : true))
        .filter((record) =>
          search
            ? record.email.includes(search) || record.name.toLowerCase().includes(search)
            : true,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (input.page - 1) * input.limit;

      return { rows: rows.slice(start, start + input.limit), total: rows.length };
    },

    async listSuperAdmins() {
      return [...staff.values()].filter(
        (record) => record.role === "SUPER_ADMIN" && record.status === "ACTIVE",
      );
    },

    async countActiveSuperAdmins(exceptId) {
      return [...staff.values()].filter(
        (record) =>
          record.role === "SUPER_ADMIN" &&
          record.status === "ACTIVE" &&
          record.id !== exceptId,
      ).length;
    },

    async incrementFailedLogins(id) {
      const record = staff.get(id);

      if (!record) {
        throw new Error(`Staff ${id} not found`);
      }

      record.failedLogins += 1;

      return record.failedLogins;
    },

    async resetFailedLogins(id, at, ip) {
      const record = staff.get(id);

      if (record) {
        record.failedLogins = 0;
        record.lockedUntil = null;
        record.lastLoginAt = at;
        record.lastLoginIp = ip;
      }
    },

    async createInvite(input) {
      const record: StaffInviteRecord = {
        id: randomUUID(),
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        invitedById: input.invitedById,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdAt: now(),
      };

      invites.set(record.id, record);

      return record;
    },

    async findInviteByTokenHash(tokenHash) {
      return (
        [...invites.values()].find((invite) => invite.tokenHash === tokenHash) ?? null
      );
    },

    async acceptInvite(id, at) {
      const invite = invites.get(id);

      if (!invite || invite.acceptedAt || invite.revokedAt) {
        return false;
      }

      invite.acceptedAt = at;
      invite.revokedAt = at;

      return true;
    },

    async revokePendingInvites(email, at) {
      for (const invite of invites.values()) {
        if (invite.email === email && !invite.acceptedAt && !invite.revokedAt) {
          invite.revokedAt = at;
        }
      }
    },

    async createPasswordReset(input) {
      const record: StaffPasswordResetRecord = {
        id: randomUUID(),
        staffId: input.staffId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: now(),
      };

      resets.set(record.id, record);

      return record;
    },

    async findPasswordResetByTokenHash(tokenHash) {
      return (
        [...resets.values()].find((reset) => reset.tokenHash === tokenHash) ?? null
      );
    },

    async usePasswordReset(id, at) {
      const reset = resets.get(id);

      if (!reset || reset.usedAt || reset.expiresAt <= at) {
        return false;
      }

      reset.usedAt = at;

      return true;
    },

    async createStaffSession(input) {
      const record: StaffSessionRecord = {
        id: randomUUID(),
        staffId: input.staffId,
        tokenHash: input.tokenHash,
        csrfHash: input.csrfHash,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        stepUpUntil: null,
        idleExpiresAt: input.idleExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        lastSeenAt: null,
        revokedAt: null,
        revokeReason: null,
        createdAt: now(),
      };

      sessions.set(record.id, record);

      return record;
    },

    async findStaffSessionByTokenHash(tokenHash) {
      return (
        [...sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null
      );
    },

    async findStaffSessionById(id) {
      return sessions.get(id) ?? null;
    },

    async updateStaffSession(id, data: StaffSessionUpdate) {
      const record = sessions.get(id);

      if (!record) {
        throw new Error(`Session ${id} not found`);
      }

      Object.assign(record, data);
    },

    async revokeStaffSession(id, reason, at) {
      const record = sessions.get(id);

      if (record && !record.revokedAt) {
        record.revokedAt = at;
        record.revokeReason = reason;
      }
    },

    async revokeAllStaffSessions(staffId, reason, at, exceptSessionId) {
      const ids: string[] = [];

      for (const record of sessions.values()) {
        if (
          record.staffId === staffId &&
          record.id !== exceptSessionId &&
          !record.revokedAt
        ) {
          record.revokedAt = at;
          record.revokeReason = reason;
          ids.push(record.id);
        }
      }

      return ids;
    },

    async listActiveStaffSessions(staffId, at) {
      return activeSessions(staffId, at).reverse();
    },

    async countActiveStaffSessions(staffId, at) {
      return activeSessions(staffId, at).length;
    },

    async oldestActiveStaffSession(staffId, at) {
      return activeSessions(staffId, at)[0] ?? null;
    },

    async recordLoginAttempt(input) {
      attempts.push({ ...input, at: input.at ?? now() });
    },

    async countLoginFailuresSince(emailHash, since) {
      return attempts.filter(
        (attempt) =>
          attempt.emailHash === emailHash &&
          !attempt.success &&
          attempt.at >= since,
      ).length;
    },

    async findCustomer(id) {
      return customers.get(id) ?? null;
    },

    async createSecurityEvent(input) {
      securityEvents.push({ ...input });
    },
  };

  return {
    repo,
    staff,
    invites,
    resets,
    sessions,
    attempts,
    securityEvents,
    customers,
    findByEmail,
  };
}

export type FakeStaffRepo = ReturnType<typeof createFakeStaffRepo>;
