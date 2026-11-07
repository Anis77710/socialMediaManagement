import type { Platform } from "../../generated/prisma/client.js";
import type {
  DiscoveredAccount,
  InsightResult,
  PublishResult,
  SocialPublisher,
} from "./types.js";

export type FakeSocialScript = {
  discovered?: DiscoveredAccount[];
  publishResults?: PublishResult[];
  insights?: InsightResult;
  refreshError?: Error;
  revokeError?: Error;
  calls?: { operation: string; externalId?: string }[];
};

export function createFakeSocialPublisher(
  platform: Platform,
  script: FakeSocialScript = {},
): SocialPublisher & {
  setScript(next: FakeSocialScript): void;
  calls: { operation: string; externalId?: string }[];
} {
  let current = script;
  const calls: { operation: string; externalId?: string }[] = [];

  return {
    platform,
    calls,
    setScript(next) {
      current = next;
    },
    async beginOAuth(input) {
      calls.push({ operation: "beginOAuth" });

      return {
        url: `https://oauth.example.test/${platform.toLowerCase()}?state=${encodeURIComponent(
          input.state,
        )}&redirect=${encodeURIComponent(input.returnTo)}`,
      };
    },
    async completeOAuth() {
      calls.push({ operation: "completeOAuth" });

      return (
        current.discovered ?? [
          {
            platform,
            externalId: `${platform.toLowerCase()}-test-1`,
            displayName: `${platform} Test Account`,
            username: `${platform.toLowerCase()}_test`,
            accessToken: `fake-access-${platform}`,
            refreshToken: `fake-refresh-${platform}`,
            userToken: `fake-user-${platform}`,
            tokenExpiresAt: null,
            scopes: ["publish"],
            meta: {},
          },
        ]
      );
    },
    async publish(input) {
      calls.push({ operation: "publish", externalId: input.externalId });
      const next = current.publishResults?.shift();

      return (
        next ?? {
          status: "PUBLISHED",
          externalPostId: `fake-post-${Date.now()}`,
          externalUrl: `https://social.example.test/${input.externalId}/posts/fake`,
        }
      );
    },
    async fetchInsights() {
      calls.push({ operation: "fetchInsights" });

      return (
        current.insights ?? {
          metrics: {
            reach: 1200,
            views: 1500,
            engagements: 90,
            followers: 640,
            saves: 12,
            linkClicks: 8,
          },
          raw: { simulated: true },
        }
      );
    },
    async refresh() {
      calls.push({ operation: "refresh" });

      if (current.refreshError) {
        throw current.refreshError;
      }

      return {
        accessToken: `fake-refreshed-${platform}`,
        refreshToken: `fake-refresh-${platform}`,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      };
    },
    async revoke() {
      calls.push({ operation: "revoke" });

      if (current.revokeError) {
        throw current.revokeError;
      }
    },
  };
}
