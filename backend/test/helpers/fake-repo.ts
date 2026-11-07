import { randomUUID } from "node:crypto";
import {
  UniqueConflictError,
  type AuthRepo,
  type ChallengeRecord,
  type ConsentInput,
  type CreateChallengeInput,
  type CreateSessionInput,
  type CreateUserInput,
  type DenyKind,
  type DeviceInfo,
  type SecurityEventInput,
  type SessionRecord,
  type UserRecord,
  type UserUpdate,
} from "../../src/modules/auth/auth.types.js";

export function createFakeRepo() {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const sessionOrder: string[] = [];
  const challenges = new Map<string, ChallengeRecord>();
  const challengeOrder: string[] = [];
  const events: SecurityEventInput[] = [];
  const consents: ConsentInput[] = [];
  const denies: { kind: DenyKind; value: string; expiresAt: Date }[] = [];
  const now = () => new Date();

  function findUserByPhone(phoneE164: string): UserRecord | null {
    for (const user of users.values()) {
      if (user.phoneE164 === phoneE164) {
        return user;
      }
    }

    return null;
  }

  function findUserByGoogleSub(googleSub: string): UserRecord | null {
    for (const user of users.values()) {
      if (user.googleSub === googleSub) {
        return user;
      }
    }

    return null;
  }

  const repo: AuthRepo = {
    async findUserByPhone(phone) {
      return findUserByPhone(phone);
    },

    async findUserByGoogleSub(googleSub) {
      return findUserByGoogleSub(googleSub);
    },

    async findUserById(id) {
      return users.get(id) ?? null;
    },

    async createUser(input: CreateUserInput) {
      if (findUserByPhone(input.phoneE164)) {
        throw new UniqueConflictError("phone already exists");
      }

      const timestamp = now();
      const user: UserRecord = {
        id: randomUUID(),
        phoneE164: input.phoneE164,
        phoneVerifiedAt: input.phoneVerifiedAt ?? null,
        email: input.email ?? null,
        googleSub: input.googleSub ?? null,
        name: input.name ?? null,
        locale: "NE",
        status: "ACTIVE",
        tokenVersion: 0,
        lastLoginAt: null,
        deletionRequestedAt: null,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      users.set(user.id, user);

      return user;
    },

    async updateUser(id, data: UserUpdate) {
      const user = users.get(id);

      if (!user) {
        throw new Error(`User ${id} not found`);
      }

      Object.assign(user, data, { updatedAt: now() });

      return user;
    },

    async incrementTokenVersion(id) {
      const user = users.get(id);

      if (!user) {
        throw new Error(`User ${id} not found`);
      }

      user.tokenVersion += 1;

      return user.tokenVersion;
    },

    async createChallenge(input: CreateChallengeInput) {
      const challenge: ChallengeRecord = {
        id: input.id,
        phoneE164: input.phoneE164,
        purpose: input.purpose,
        codeHash: input.codeHash,
        attempts: 0,
        sendCount: 0,
        userId: input.userId ?? null,
        ip: input.ip ?? null,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: now(),
      };

      challenges.set(challenge.id, challenge);
      challengeOrder.push(challenge.id);

      return challenge;
    },

    async findChallenge(id) {
      return challenges.get(id) ?? null;
    },

    async findLatestChallenge(phone, purpose) {
      for (let index = challengeOrder.length - 1; index >= 0; index -= 1) {
        const challenge = challenges.get(challengeOrder[index]);

        if (challenge?.phoneE164 === phone && challenge.purpose === purpose) {
          return challenge;
        }
      }

      return null;
    },

    async incrementChallengeAttempts(id) {
      const challenge = challenges.get(id);

      if (!challenge) {
        throw new Error(`Challenge ${id} not found`);
      }

      challenge.attempts += 1;

      return challenge.attempts;
    },

    async consumeChallenge(id, at) {
      const challenge = challenges.get(id);

      if (challenge) {
        challenge.consumedAt = at;
      }
    },

    async createSession(input: CreateSessionInput) {
      const timestamp = now();
      const session: SessionRecord = {
        id: randomUUID(),
        userId: input.userId,
        familyId: input.familyId,
        tokenHash: input.tokenHash,
        replacedById: null,
        rotatedAt: null,
        deviceName: input.deviceName ?? null,
        platform: input.platform ?? null,
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
        expiresAt: input.expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        revokedAt: null,
        revokeReason: null,
        lastUsedAt: input.lastUsedAt ?? null,
        createdAt: timestamp,
      };

      sessions.set(session.id, session);
      sessionOrder.push(session.id);

      return session;
    },

    async findSessionByTokenHash(tokenHash) {
      for (const session of sessions.values()) {
        if (session.tokenHash === tokenHash) {
          return session;
        }
      }

      return null;
    },

    async findSessionById(id) {
      return sessions.get(id) ?? null;
    },

    async markSessionRotated(id, replacedById, rotatedAt) {
      const session = sessions.get(id);

      if (!session || session.rotatedAt || session.revokedAt) {
        return false;
      }

      session.replacedById = replacedById;
      session.rotatedAt = rotatedAt;

      return true;
    },

    async revokeSession(id, reason, at) {
      const session = sessions.get(id);

      if (session && !session.revokedAt) {
        session.revokedAt = at;
        session.revokeReason = reason;
      }
    },

    async revokeFamily(familyId, reason, at) {
      const ids: string[] = [];

      for (const session of sessions.values()) {
        if (session.familyId === familyId && !session.revokedAt) {
          session.revokedAt = at;
          session.revokeReason = reason;
          ids.push(session.id);
        }
      }

      return ids;
    },

    async revokeAllSessions(userId, reason, at) {
      const ids: string[] = [];

      for (const session of sessions.values()) {
        if (session.userId === userId && !session.revokedAt) {
          session.revokedAt = at;
          session.revokeReason = reason;
          ids.push(session.id);
        }
      }

      return ids;
    },

    async listSessionIdsByFamily(familyId) {
      return [...sessions.values()]
        .filter((session) => session.familyId === familyId)
        .map((session) => session.id);
    },

    async listActiveSessions(userId, at) {
      return [...sessions.values()]
        .filter(
          (session) =>
            session.userId === userId &&
            !session.revokedAt &&
            !session.replacedById &&
            session.expiresAt > at,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async countActiveFamilies(userId, at) {
      const families = new Set(
        (await repo.listActiveSessions(userId, at)).map((session) => session.familyId),
      );

      return families.size;
    },

    async oldestActiveFamily(userId, at) {
      const active = (await repo.listActiveSessions(userId, at)).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );

      return active[0]?.familyId ?? null;
    },

    async hasSeenDevice(userId, device: DeviceInfo) {
      return [...sessions.values()].some(
        (session) =>
          session.userId === userId &&
          ((device.name !== undefined && session.deviceName === device.name) ||
            (device.platform !== undefined && session.platform === device.platform)),
      );
    },

    async touchSession(id, at) {
      const session = sessions.get(id);

      if (session) {
        session.lastUsedAt = at;
      }
    },

    async createConsents(input) {
      consents.push(input);
    },

    async createSecurityEvent(event) {
      events.push(event);
    },

    async isDenied(kind, value, at) {
      return denies.some(
        (entry) => entry.kind === kind && entry.value === value && entry.expiresAt > at,
      );
    },

    async listActiveCidrs(at) {
      return denies
        .filter((entry) => entry.kind === "CIDR" && entry.expiresAt > at)
        .map((entry) => entry.value);
    },

    async changePhone(userId, newPhone, keepFamilyId, reason, at) {
      const user = users.get(userId);

      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      user.phoneE164 = newPhone;
      user.phoneVerifiedAt = at;

      const ids: string[] = [];

      for (const session of sessions.values()) {
        if (
          session.userId === userId &&
          session.familyId !== keepFamilyId &&
          !session.revokedAt
        ) {
          session.revokedAt = at;
          session.revokeReason = reason;
          ids.push(session.id);
        }
      }

      return ids;
    },

    async linkGoogle(userId, googleSub, email) {
      const existing = findUserByGoogleSub(googleSub);

      if (existing && existing.id !== userId) {
        throw new UniqueConflictError("google account already linked");
      }

      const user = users.get(userId);

      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      user.googleSub = googleSub;

      if (email) {
        user.email = email;
      }
    },

    async unlinkGoogle(userId) {
      const user = users.get(userId);

      if (user) {
        user.googleSub = null;
        user.email = null;
      }
    },

    async setDeletion(userId, requestedAt) {
      const user = users.get(userId);

      if (user) {
        user.status = requestedAt ? "DELETION_PENDING" : "ACTIVE";
        user.deletionRequestedAt = requestedAt;
      }
    },
  };

  return {
    repo,
    users,
    sessions,
    challenges,
    events,
    consents,
    denies,
    findUserByPhone,
  };
}

export type FakeRepo = ReturnType<typeof createFakeRepo>;
