import { SmsProviderError, type SmsProvider } from "./types.js";

type SecondaryOptions = {
  url: string;
  token: string;
  from: string;
};

export function createSecondarySmsProvider(options: SecondaryOptions): SmsProvider {
  return {
    async send(message) {
      const body = new URLSearchParams({
        token: options.token,
        from: options.from,
        to: message.to.replace(/^\+977/, ""),
        text: message.text,
      });

      let response: Response;

      try {
        response = await fetch(options.url, {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        throw new SmsProviderError(
          error instanceof Error ? error.message : "Secondary SMS request failed",
          { retryable: true },
        );
      }

      if (!response.ok) {
        throw new SmsProviderError(`Secondary SMS returned ${response.status}`, {
          retryable: response.status >= 500,
        });
      }
    },
  };
}
