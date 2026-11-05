import type { z } from "zod";

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
};

export type AiJsonInput<T> = {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  timeoutMs: number;
};

export interface AiProvider {
  name: string;
  json<T>(input: AiJsonInput<T>): Promise<{ data: T; usage: AiUsage }>;
}
