import { SmsProviderError, type SmsAlert, type SmsProvider } from "./types.js";

export function createFallbackSmsProvider(
  primary: SmsProvider,
  fallback: SmsProvider,
  onAlert: SmsAlert,
): SmsProvider {
  return {
    async send(message) {
      try {
        await primary.send(message);
      } catch (error) {
        if (!(error instanceof SmsProviderError) || !error.retryable) {
          throw error;
        }

        onAlert("Primary SMS provider failed, using fallback", {
          reason: error.message,
          lowCredit: error.lowCredit,
        });

        await fallback.send(message);
      }
    },
  };
}
