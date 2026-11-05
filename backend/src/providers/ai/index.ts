import type { Env } from "../../config/env.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createFakeAiProvider } from "./fake.js";
import type { AiProvider } from "./types.js";

export function createAiProviderFromEnv(env: Env): AiProvider {
  if (env.AI_DRIVER === "anthropic" && env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider(env.ANTHROPIC_API_KEY);
  }

  return createFakeAiProvider();
}

export type { AiProvider, AiJsonInput, AiUsage } from "./types.js";
export { createFakeAiProvider } from "./fake.js";
