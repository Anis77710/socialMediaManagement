import type { Platform } from "../../generated/prisma/client.js";

export type OAuthStart = {
  businessId: string;
  userId: string;
  platform: Platform;
  state: string;
  pkceVerifier?: string;
  returnTo: string;
};

export type OAuthReturn = {
  code: string;
  state: string;
  redirectUri: string;
  pkceVerifier?: string;
};

export type DiscoveredAccount = {
  platform: Platform;
  externalId: string;
  displayName: string;
  username?: string | null;
  avatarUrl?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  userToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes: string[];
  meta?: Record<string, unknown>;
};

export type PublishInput = {
  platform: Platform;
  externalId: string;
  accessToken: string;
  caption: string;
  imageUrl?: string | null;
  format: "IMAGE" | "REEL";
  containerId?: string | null;
  meta?: Record<string, unknown> | null;
};

export type PublishResult =
  | { status: "PUBLISHED"; externalPostId: string; externalUrl: string | null }
  | { status: "PROCESSING"; containerId: string }
  | { status: "LIMIT"; retryAfterSec: number; detail: string }
  | { status: "RETRYABLE"; detail: string }
  | { status: "TERMINAL_CONTENT"; detail: string }
  | { status: "TERMINAL_AUTH"; detail: string };

export type InsightQuery = {
  platform: Platform;
  externalId: string;
  accessToken: string;
  since: Date;
  until: Date;
  postExternalId?: string;
};

export type InsightResult = {
  metrics: Record<string, number | null>;
  raw: Record<string, unknown>;
};

export interface SocialPublisher {
  platform: Platform;
  beginOAuth(input: OAuthStart): Promise<{ url: string }>;
  completeOAuth(input: OAuthReturn): Promise<DiscoveredAccount[]>;
  publish(input: PublishInput): Promise<PublishResult>;
  fetchInsights(input: InsightQuery): Promise<InsightResult>;
  refresh(account: {
    accessToken: string;
    refreshToken: string | null;
    userToken: string | null;
  }): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date | null }>;
  revoke(account: { accessToken: string; externalId: string }): Promise<void>;
}
