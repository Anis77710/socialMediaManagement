import fp from "fastify-plugin";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

type RedisPluginOptions = {
  redisUrl?: string;
};

export const redisPlugin = fp<RedisPluginOptions>(
  async (app, options) => {
    const redis = new Redis(options.redisUrl ?? env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    await redis.connect();
    await redis.ping();

    app.decorate("redis", redis);

    app.addHook("onClose", async () => {
      await redis.quit();
    });
  },
  {
    name: "redis",
  },
);
