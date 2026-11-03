import type { Redis } from "ioredis";

export type JsonCache = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
};

export function createRedisJsonCache(redis: Redis): JsonCache {
  return {
    async get<T>(key: string) {
      const raw = await redis.get(key);

      return raw === null ? null : (JSON.parse(raw) as T);
    },

    async set(key, value, ttlSec) {
      await redis.set(key, JSON.stringify(value), "EX", ttlSec);
    },

    async delete(key) {
      await redis.del(key);
    },
  };
}

export function createMemoryJsonCache(now: () => number = Date.now): JsonCache {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  return {
    async get<T>(key: string) {
      const entry = entries.get(key);

      if (!entry) {
        return null;
      }

      if (entry.expiresAt <= now()) {
        entries.delete(key);

        return null;
      }

      return JSON.parse(entry.value) as T;
    },

    async set(key, value, ttlSec) {
      entries.set(key, {
        value: JSON.stringify(value),
        expiresAt: now() + ttlSec * 1000,
      });
    },

    async delete(key) {
      entries.delete(key);
    },
  };
}
