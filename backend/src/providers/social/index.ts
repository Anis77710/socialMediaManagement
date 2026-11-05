import type { Platform } from "../../generated/prisma/client.js";
import type { Env } from "../../config/env.js";
import { createFakeSocialPublisher } from "./fake.js";
import { createMetaPublisher } from "./meta.js";
import type { SocialPublisher } from "./types.js";

export type SocialPublishers = Record<Platform, SocialPublisher>;

export function createSocialPublishersFromEnv(env: Env): SocialPublishers {
  if (
    env.SOCIAL_DRIVER === "meta" &&
    env.META_APP_ID &&
    env.META_APP_SECRET
  ) {
    const meta = createMetaPublisher({
      appId: env.META_APP_ID,
      appSecret: env.META_APP_SECRET,
      graphVersion: env.META_GRAPH_VERSION,
      redirectUri: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/v1/public/oauth/meta/callback`,
    });

    return {
      FACEBOOK: meta,
      INSTAGRAM: meta,
      TIKTOK: createFakeSocialPublisher("TIKTOK"),
      GOOGLE_BUSINESS: createFakeSocialPublisher("GOOGLE_BUSINESS"),
    };
  }

  return {
    FACEBOOK: createFakeSocialPublisher("FACEBOOK"),
    INSTAGRAM: createFakeSocialPublisher("INSTAGRAM"),
    TIKTOK: createFakeSocialPublisher("TIKTOK"),
    GOOGLE_BUSINESS: createFakeSocialPublisher("GOOGLE_BUSINESS"),
  };
}

export type {
  SocialPublisher,
  DiscoveredAccount,
  OAuthStart,
  OAuthReturn,
  PublishInput,
  PublishResult,
  InsightQuery,
  InsightResult,
} from "./types.js";
