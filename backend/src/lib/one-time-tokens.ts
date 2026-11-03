import type { Redis } from "ioredis";

export type OneTimeTokenStore = {
  consume(jti: string, ttlSec: number): Promise<boolean>;
};

const prefix = "admin:jti:";

export function createRedisOneTimeTokenStore(redis: Redis): OneTimeTokenStore {
  return {
    async consume(jti, ttlSec) {
      const result = await redis.set(`${prefix}${jti}`, "1", "EX", ttlSec, "NX");

      return result === "OK";
    },
  };
}

export function createMemoryOneTimeTokenStore(now: () => number = Date.now): OneTimeTokenStore {
  const consumed = new Map<string, number>();

  return {
    async consume(jti, ttlSec) {
      const expiresAt = consumed.get(jti);

      if (expiresAt !== undefined && expiresAt > now()) {
        return false;
      }

      consumed.set(jti, now() + ttlSec * 1000);

      return true;
    },
  };
}
