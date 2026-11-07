import type { Env } from "../../config/env.js";
import type { SmsAlert } from "./types.js";

type Log = {
  error(object: Record<string, unknown>, message: string): void;
};

export function createSmsAlert(env: Env, log: Log): SmsAlert {
  return (message, meta) => {
    log.error({ ...meta, alert: "sms" }, message);

    if (!env.SMS_ALERT_WEBHOOK_URL) {
      return;
    }

    void fetch(env.SMS_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, meta }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {
      log.error({ alert: "sms" }, "Failed to deliver the SMS alert webhook");
    });
  };
}
