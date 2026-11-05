import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSec: number;
};

export type DailyResult = {
  allowed: boolean;
  count: number;
};

export interface RateLimiter {
  hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
  consumeDaily(key: string, cap: number, ttlSec?: number): Promise<DailyResult>;
  increment(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<number>;
}

const slidingWindowScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2]) * 1000
local member = ARGV[3]
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs - windowMs)
local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 0
  if oldest[2] then
    retryAfter = math.ceil((tonumber(oldest[2]) + windowMs - nowMs) / 1000)
  end
  return {0, count, retryAfter}
end

redis.call('ZADD', key, nowMs, member)
redis.call('PEXPIRE', key, windowMs)
return {1, count + 1, 0}
`;

const consumeDailyScript = `
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')

if count >= limit then
  return {0, count}
end

local nextCount = redis.call('INCR', KEYS[1])
if nextCount == 1 then
  redis.call('EXPIRE', KEYS[1], ttl)
end

return {1, nextCount}
`;

export function createRedisRateLimiter(redis: Redis): RateLimiter {
  return {
    async hit(key, limit, windowSec) {
      const result = (await redis.eval(
        slidingWindowScript,
        1,
        key,
        String(limit),
        String(windowSec),
        `${Date.now()}-${randomUUID()}`,
      )) as [number, number, number];

      const [allowed, count, retryAfterSec] = result;

      return {
        allowed: allowed === 1,
        count,
        remaining: Math.max(limit - count, 0),
        retryAfterSec,
      };
    },

    async consumeDaily(key, cap, ttlSec = 86_400) {
      const result = (await redis.eval(
        consumeDailyScript,
        1,
        key,
        String(cap),
        String(ttlSec),
      )) as [number, number];

      return { allowed: result[0] === 1, count: result[1] };
    },

    async increment(key, ttlSec) {
      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, ttlSec);
      }

      return count;
    },

    async get(key) {
      const value = await redis.get(key);

      return Number(value ?? 0);
    },
  };
}

type WindowEntry = { at: number; id: string };
type Counter = { count: number; expiresAt: number };

export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, WindowEntry[]>();
  const counters = new Map<string, Counter>();

  function prune(key: string, windowMs: number) {
    const current = now();
    const entries = (windows.get(key) ?? []).filter((entry) => entry.at > current - windowMs);
    windows.set(key, entries);

    return entries;
  }

  return {
    async hit(key, limit, windowSec) {
      const windowMs = windowSec * 1000;
      const entries = prune(key, windowMs);

      if (entries.length >= limit) {
        const oldest = entries[0];
        const retryAfterSec = oldest
          ? Math.max(Math.ceil((oldest.at + windowMs - now()) / 1000), 1)
          : 0;

        return {
          allowed: false,
          count: entries.length,
          remaining: 0,
          retryAfterSec,
        };
      }

      entries.push({ at: now(), id: randomUUID() });

      return {
        allowed: true,
        count: entries.length,
        remaining: Math.max(limit - entries.length, 0),
        retryAfterSec: 0,
      };
    },

    async consumeDaily(key, cap, ttlSec = 86_400) {
      const current = now();
      const existing = counters.get(key);

      if (!existing || existing.expiresAt <= current) {
        counters.set(key, { count: 1, expiresAt: current + ttlSec * 1000 });

        return { allowed: true, count: 1 };
      }

      if (existing.count >= cap) {
        return { allowed: false, count: existing.count };
      }

      existing.count += 1;

      return { allowed: true, count: existing.count };
    },

    async increment(key, ttlSec) {
      const current = now();
      const existing = counters.get(key);

      if (!existing || existing.expiresAt <= current) {
        counters.set(key, { count: 1, expiresAt: current + ttlSec * 1000 });

        return 1;
      }

      existing.count += 1;

      return existing.count;
    },

    async get(key) {
      const existing = counters.get(key);

      return existing && existing.expiresAt > now() ? existing.count : 0;
    },
  };
}
