import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { isQuietHours } from "../../lib/time.js";
import { cursorWhere, decodeCursor, pageResult } from "../../lib/cursor.js";
import type { PushProvider } from "../../providers/push/types.js";
import type { SmsSender } from "../../providers/sms/types.js";

export type NotificationChannel = "IN_APP" | "PUSH" | "SMS";

export type NotifyInput = {
  userId: string;
  businessId?: string | null;
  type: string;
  titleNe: string;
  titleEn: string;
  bodyNe: string;
  bodyEn: string;
  data?: Prisma.InputJsonValue;
  channels?: NotificationChannel[];
  dedupeKey?: string;
  critical?: boolean;
};

export type NotificationService = ReturnType<typeof createNotificationService>;

export function createNotificationService(deps: {
  prisma: PrismaClient;
  push: PushProvider;
  sms: SmsSender;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function notify(input: NotifyInput): Promise<void> {
    const requested = input.channels ?? ["IN_APP", "PUSH"];
    const at = now();
    const quiet = isQuietHours(at) && !input.critical;
    const channels = requested.filter((channel) => {
      if (channel === "IN_APP") {
        return true;
      }

      if (quiet && channel === "SMS") {
        return false;
      }

      return true;
    });

    let notification;

    try {
      notification = await deps.prisma.notification.create({
        data: {
          userId: input.userId,
          businessId: input.businessId ?? null,
          type: input.type,
          titleNe: input.titleNe,
          titleEn: input.titleEn,
          bodyNe: input.bodyNe,
          bodyEn: input.bodyEn,
          ...(input.data === undefined ? {} : { data: input.data }),
          channels,
          ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return;
      }

      throw error;
    }

    if (channels.includes("PUSH") && !quiet) {
      const devices = await deps.prisma.device.findMany({
        where: { userId: input.userId },
        select: { pushToken: true },
      });
      const tokens = devices.map((device) => device.pushToken);

      if (tokens.length > 0) {
        const result = await deps.push.send(tokens, {
          title: input.titleNe,
          body: input.bodyNe,
          data: { type: input.type, notificationId: notification.id },
        });

        if (result.invalidTokens.length > 0) {
          await deps.prisma.device.deleteMany({
            where: { pushToken: { in: result.invalidTokens } },
          });
        }
      }
    }

    if (channels.includes("SMS") && !quiet) {
      const user = await deps.prisma.user.findUnique({
        where: { id: input.userId },
        select: { phoneE164: true, locale: true },
      });

      if (user) {
        try {
          await deps.sms.enqueue({
            to: user.phoneE164,
            text: user.locale === "NE" ? input.bodyNe : input.bodyEn,
            purpose: "ALERT",
            ref: notification.id,
          });
        } catch {
          return;
        }
      }
    }

    await deps.prisma.notification.update({
      where: { id: notification.id },
      data: { sentAt: at },
    });
  }

  async function list(userId: string, query: { cursor?: string; limit?: number; unreadOnly?: boolean }) {
    const limit = Math.min(query.limit ?? 20, 100);
    const cursor = decodeCursor(query.cursor);
    const rows = await deps.prisma.notification.findMany({
      where: {
        userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(cursor ? cursorWhere(cursor) : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    return pageResult(rows, limit);
  }

  async function markRead(userId: string, ids: string[]): Promise<number> {
    const result = await deps.prisma.notification.updateMany({
      where: { userId, id: { in: ids }, readAt: null },
      data: { readAt: now() },
    });

    return result.count;
  }

  async function getPreferences(userId: string) {
    const preference = await deps.prisma.notificationPreference.findUnique({
      where: { userId },
    });

    return (
      preference ?? {
        userId,
        channels: ["IN_APP", "PUSH"],
        quietHours: true,
        language: "NE" as const,
      }
    );
  }

  async function setPreferences(
    userId: string,
    input: { channels: NotificationChannel[]; quietHours: boolean; language: "NE" | "EN" },
  ) {
    return deps.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        channels: input.channels,
        quietHours: input.quietHours,
        language: input.language,
      },
      update: {
        channels: input.channels,
        quietHours: input.quietHours,
        language: input.language,
      },
    });
  }

  return { notify, list, markRead, getPreferences, setPreferences };
}

