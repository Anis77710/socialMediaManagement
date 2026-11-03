import { SmsProviderError, type SmsAlert, type SmsProvider } from "./types.js";

type SparrowOptions = {
  url: string;
  token: string;
  from: string;
  onAlert: SmsAlert;
};

type SparrowResponse = {
  response_code?: number;
  response?: string;
  count?: number;
};

const lowCreditCodes = new Set([1012, 1013]);

export function createSparrowSmsProvider(options: SparrowOptions): SmsProvider {
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
          error instanceof Error ? error.message : "Sparrow request failed",
          { retryable: true },
        );
      }

      if (response.status >= 500) {
        throw new SmsProviderError(`Sparrow returned ${response.status}`, { retryable: true });
      }

      let payload: SparrowResponse = {};

      try {
        payload = (await response.json()) as SparrowResponse;
      } catch {
        throw new SmsProviderError("Sparrow returned a non-JSON response", {
          retryable: response.status >= 500,
        });
      }

      if (payload.response_code === 200) {
        return;
      }

      const lowCredit = payload.response_code !== undefined && lowCreditCodes.has(payload.response_code);

      if (lowCredit) {
        options.onAlert("SMS provider credit is low or exhausted", {
          provider: "sparrow",
          responseCode: payload.response_code,
        });
      }

      throw new SmsProviderError(
        `Sparrow rejected the message: ${payload.response_code ?? response.status}`,
        { retryable: lowCredit || response.status >= 500, lowCredit },
      );
    },
  };
}
