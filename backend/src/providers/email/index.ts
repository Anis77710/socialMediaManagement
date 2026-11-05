import type { Env } from "../../config/env.js";
import { createConsoleEmailProvider } from "./console.js";
import { createResendEmailProvider } from "./resend.js";
import type { EmailProvider } from "./types.js";

type Logger = {
  info(object: Record<string, unknown>, message: string): void;
};

export function createEmailProviderFromEnv(
  env: Env,
  logger: Logger,
  fetchImpl?: typeof fetch,
): EmailProvider {
  if (env.EMAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required for the resend email provider");
    }

    return createResendEmailProvider({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  if (env.EMAIL_PROVIDER === "console") {
    return createConsoleEmailProvider(logger);
  }

  return {
    async send() {
      return undefined;
    },
  };
}
