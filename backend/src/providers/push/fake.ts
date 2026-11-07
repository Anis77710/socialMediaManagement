import type { PushMessage, PushProvider } from "./types.js";

export function createFakePushProvider(): PushProvider & {
  messages: { tokens: string[]; message: PushMessage }[];
} {
  const messages: { tokens: string[]; message: PushMessage }[] = [];

  return {
    messages,
    async send(tokens, message) {
      messages.push({ tokens, message });

      return { sent: tokens.length, invalidTokens: [] };
    },
  };
}
