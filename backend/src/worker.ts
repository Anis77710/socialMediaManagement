import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { claimOutboxBatch } from "./lib/outbox.js";

const app = await buildApp();
const services = app.services;
let stopping = false;
const timers: NodeJS.Timeout[] = [];

function every(name: string, intervalMs: number, task: () => Promise<unknown>): void {
  const run = async () => {
    if (stopping) {
      return;
    }

    try {
      await task();
    } catch (error) {
      app.log.error({ err: error, task: name }, "Worker task failed");
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timers.push(timer);
}

async function processOutbox(): Promise<void> {
  const events = await claimOutboxBatch(app.prisma, 25);

  for (const event of events) {
    try {
      if (event.type === "post.publish") {
        const payload = event.payload as { postId?: string };

        if (payload.postId) {
          await services.posts.publishTargets(payload.postId);
        }
      }

      await app.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
    } catch (error) {
      app.log.error({ err: error, outboxId: event.id, type: event.type }, "Outbox event failed");

      if (event.attempts >= 8) {
        await app.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
      }
    }
  }
}

async function publishDue(): Promise<void> {
  const due = await services.posts.dueScheduled(25);

  for (const post of due) {
    await services.posts.publishTargets(post.id);
  }
}

async function prune(): Promise<void> {
  const now = new Date();
  await app.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
  await app.prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } },
  });
  await app.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
}

every("outbox", 5_000, processOutbox);
every("scheduled-posts", 30_000, publishDue);
every("token-refresh", 6 * 3_600_000, () => services.connections.refreshExpiring(7));
every("renewals", 3_600_000, () => services.billing.processRenewals());
every("stale-payments", 15 * 60_000, () => services.billing.expireStalePayments());
every("insights", 6 * 3_600_000, () => services.analytics.syncInsights());
every("autopilot", 15 * 60_000, () => services.automation.runAutopilot(10));
every("prune", 6 * 3_600_000, prune);

app.log.info({ role: env.APP_ROLE ?? "worker" }, "Worker started");

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;
  app.log.info({ signal }, "Worker shutting down");

  for (const timer of timers) {
    clearInterval(timer);
  }

  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
