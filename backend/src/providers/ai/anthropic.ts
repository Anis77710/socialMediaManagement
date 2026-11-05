import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider } from "./types.js";

export function createAnthropicProvider(apiKey: string): AiProvider {
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  return {
    name: "anthropic",
    async json<T>(input: {
      model: string;
      system: string;
      user: string;
      schema: { parse(value: unknown): T };
      maxTokens: number;
      timeoutMs: number;
    }): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number; model: string; latencyMs: number } }> {
      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

      try {
        const response = await client.messages.create(
          {
            model: input.model,
            max_tokens: input.maxTokens,
            system: `${input.system}\nReturn only a JSON object. No markdown fences.`,
            messages: [{ role: "user", content: input.user }],
          },
          { signal: controller.signal },
        );
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        const parsed: unknown = JSON.parse(text);

        return {
          data: input.schema.parse(parsed),
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            model: input.model,
            latencyMs: Date.now() - started,
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
