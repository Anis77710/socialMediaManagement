import type { Env } from "../../config/env.js";
import { createSmsAlert } from "./alerts.js";
import { createConsoleSmsProvider } from "./console.js";
import { createFallbackSmsProvider } from "./fallback.js";
import { FakeSmsProvider } from "./fake.js";
import { createSecondarySmsProvider } from "./secondary.js";
import { createSparrowSmsProvider } from "./sparrow.js";
import type { SmsAlert, SmsProvider } from "./types.js";

type Log = {
  info(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

export type SmsProviderBundle = {
  provider: SmsProvider;
  alert: SmsAlert;
  fake?: FakeSmsProvider;
};

export function createSmsProviderFromEnv(env: Env, log: Log): SmsProviderBundle {
  const alert = createSmsAlert(env, log);

  if (env.SMS_PROVIDER === "console") {
    return { provider: createConsoleSmsProvider(log), alert };
  }

  if (env.SMS_PROVIDER === "fake") {
    const fake = new FakeSmsProvider();

    return { provider: fake, alert, fake };
  }

  if (env.SMS_PROVIDER === "secondary") {
    return {
      provider: createSecondarySmsProvider({
        url: env.SMS_FALLBACK_URL ?? "",
        token: env.SMS_FALLBACK_TOKEN ?? "",
        from: env.SMS_FALLBACK_FROM ?? "",
      }),
      alert,
    };
  }

  const sparrow = createSparrowSmsProvider({
    url: env.SPARROW_URL,
    token: env.SPARROW_TOKEN ?? "",
    from: env.SPARROW_FROM ?? "",
    onAlert: alert,
  });

  if (env.SMS_FALLBACK_URL && env.SMS_FALLBACK_TOKEN && env.SMS_FALLBACK_FROM) {
    return {
      provider: createFallbackSmsProvider(
        sparrow,
        createSecondarySmsProvider({
          url: env.SMS_FALLBACK_URL,
          token: env.SMS_FALLBACK_TOKEN,
          from: env.SMS_FALLBACK_FROM,
        }),
        alert,
      ),
      alert,
    };
  }

  return { provider: sparrow, alert };
}
