import type { AiProvider } from "./types.js";

export type FakeAiScript = {
  response?: unknown;
  error?: Error;
  delayMs?: number;
};

export function createFakeAiProvider(script: FakeAiScript = {}): AiProvider & {
  calls: { model: string; system: string; user: string }[];
  setScript(next: FakeAiScript): void;
} {
  let current = script;
  const calls: { model: string; system: string; user: string }[] = [];

  return {
    name: "fake",
    calls,
    setScript(next) {
      current = next;
    },
    async json<T>(input: {
      model: string;
      system: string;
      user: string;
      schema: { parse(value: unknown): T };
    }): Promise<{
      data: T;
      usage: { inputTokens: number; outputTokens: number; model: string; latencyMs: number };
    }> {
      const started = Date.now();
      calls.push({ model: input.model, system: input.system, user: input.user });

      if (current.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, current.delayMs));
      }

      if (current.error) {
        throw current.error;
      }

      const raw = current.response ?? {
        eyebrow: "आजको अफर",
        headline: "{{value}} मा छुट",
        caption: "{{business}} मा आज {{value}} मा छुट। थप जानकारी: {{phone}}",
        hashtags: [],
      };

      return {
        data: input.schema.parse(raw),
        usage: {
          inputTokens: Math.ceil(input.user.length / 4),
          outputTokens: Math.ceil(JSON.stringify(raw).length / 4),
          model: input.model,
          latencyMs: Date.now() - started,
        },
      };
    },
  };
}
