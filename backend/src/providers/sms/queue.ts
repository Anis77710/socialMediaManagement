import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { SmsMessage, SmsProvider, SmsSender } from "./types.js";

type Log = {
  error(object: Record<string, unknown>, message: string): void;
};

export function createImmediateSmsSender(provider: SmsProvider): SmsSender {
  return {
    async enqueue(message) {
      await provider.send(message);
    },
    async close() {
      return Promise.resolve();
    },
  };
}

export function createBullMqSmsSender(
  redisUrl: string,
  provider: SmsProvider,
  log: Log,
): SmsSender {
  const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<SmsMessage>("sms", { connection: queueConnection });
  const worker = new Worker<SmsMessage>(
    "sms",
    async (job) => {
      await provider.send(job.data);
    },
    {
      connection: workerConnection,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, error) => {
    log.error({ jobId: job?.id, err: error }, "SMS job failed");
  });

  return {
    async enqueue(message) {
      await queue.add("send", message, {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    },

    async close() {
      await worker.close();
      await queue.close();
      await queueConnection.quit();
      await workerConnection.quit();
    },
  };
}
