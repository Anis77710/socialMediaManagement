import type { Redis } from "ioredis";

export interface RevocationStore {
  revoke(sessionId: string, ttlSec: number): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

const prefix = "auth:revoked:";

export function createRedisRevocationStore(redis: Redis): RevocationStore {
  return {
    async revoke(sessionId, ttlSec) {
      await redis.set(`${prefix}${sessionId}`, "1", "EX", ttlSec);
    },

    async isRevoked(sessionId) {
      return (await redis.exists(`${prefix}${sessionId}`)) === 1;
    },
  };
}

export function createMemoryRevocationStore(now: () => number = Date.now): RevocationStore {
  const revoked = new Map<string, number>();

  return {
    async revoke(sessionId, ttlSec) {
      revoked.set(sessionId, now() + ttlSec * 1000);
    },

    async isRevoked(sessionId) {
      const expiresAt = revoked.get(sessionId);

      if (expiresAt === undefined) {
        return false;
      }

      if (expiresAt <= now()) {
        revoked.delete(sessionId);

        return false;
      }

      return true;
    },
  };
}
