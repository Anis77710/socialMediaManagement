import type { PushProvider } from "./types.js";
import { createFakePushProvider } from "./fake.js";

export function createPushProvider(): PushProvider {
  return createFakePushProvider();
}

export type { PushProvider, PushMessage, PushResult } from "./types.js";
