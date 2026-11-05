import type {
  DiscoveredAccount,
  InsightQuery,
  InsightResult,
  OAuthReturn,
  OAuthStart,
  PublishInput,
  PublishResult,
  SocialPublisher,
} from "./types.js";

type MetaOptions = {
  appId: string;
  appSecret: string;
  graphVersion: string;
  redirectUri: string;
  timeoutMs?: number;
};

const FB_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_read_user_engagement",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

function graphBase(version: string): string {
  return `https://graph.facebook.com/${version}`;
}

async function graphJson<T>(
  url: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    ...(options.body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }
      : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const raw = (await response.json()) as T & { error?: { message?: string; code?: number } };

  if (!response.ok) {
    throw new Error(raw.error?.message ?? `Meta request failed with ${response.status}`);
  }

  return raw;
}

function classifyMetaError(error: unknown): PublishResult {
  const message = error instanceof Error ? error.message : String(error);
  const auth = /oauth|token|permission|session/i.test(message);

  return auth
    ? { status: "TERMINAL_AUTH", detail: message }
    : { status: "RETRYABLE", detail: message };
}

export function createMetaPublisher(options: MetaOptions): SocialPublisher {
  const base = graphBase(options.graphVersion);

  return {
    platform: "FACEBOOK",

    async beginOAuth(input: OAuthStart) {
      const url = new URL("https://www.facebook.com/v23.0/dialog/oauth");
      url.searchParams.set("client_id", options.appId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("state", input.state);
      url.searchParams.set("scope", FB_SCOPES.join(","));
      url.searchParams.set("response_type", "code");

      return { url: url.toString() };
    },

    async completeOAuth(input: OAuthReturn) {
      const tokenUrl = new URL(`${base}/oauth/access_token`);
      tokenUrl.searchParams.set("client_id", options.appId);
      tokenUrl.searchParams.set("client_secret", options.appSecret);
      tokenUrl.searchParams.set("redirect_uri", input.redirectUri);
      tokenUrl.searchParams.set("code", input.code);
      const token = await graphJson<{ access_token: string; expires_in?: number }>(
        tokenUrl.toString(),
      );
      const longLived = await graphJson<{ access_token: string; expires_in?: number }>(
        `${base}/oauth/access_token?grant_type=fb_exchange_token&client_id=${options.appId}&client_secret=${options.appSecret}&fb_exchange_token=${token.access_token}`,
      );
      const userToken = longLived.access_token;
      const accounts = await graphJson<{
        data: { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }[];
      }>(`${base}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`);
      const discovered: DiscoveredAccount[] = [];

      for (const page of accounts.data) {
        const pageToken = page.access_token;
        let username: string | null = null;
        let avatar: string | null = null;

        try {
          const details = await graphJson<{ username?: string; picture?: { data?: { url?: string } } }>(
            `${base}/${page.id}?fields=username,picture&access_token=${pageToken}`,
          );
          username = details.username ?? null;
          avatar = details.picture?.data?.url ?? null;
        } catch {
          username = null;
        }

        discovered.push({
          platform: "FACEBOOK",
          externalId: page.id,
          displayName: page.name,
          username,
          avatarUrl: avatar,
          accessToken: pageToken,
          refreshToken: null,
          userToken,
          tokenExpiresAt: null,
          scopes: FB_SCOPES,
          meta: { pageId: page.id },
        });

        if (page.instagram_business_account?.id) {
          discovered.push({
            platform: "INSTAGRAM",
            externalId: page.instagram_business_account.id,
            displayName: `${page.name} (Instagram)`,
            username,
            avatarUrl: avatar,
            accessToken: pageToken,
            refreshToken: null,
            userToken,
            tokenExpiresAt: null,
            scopes: FB_SCOPES,
            meta: { pageId: page.id, instagramId: page.instagram_business_account.id },
          });
        }
      }

      return discovered;
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      try {
        if (input.platform === "FACEBOOK") {
          if (input.imageUrl) {
            const result = await graphJson<{ id: string; post_id?: string }>(
              `${base}/${input.externalId}/photos`,
              {
                method: "POST",
                body: { url: input.imageUrl, message: input.caption },
              },
            );
            const id = result.post_id ?? result.id;

            return {
              status: "PUBLISHED",
              externalPostId: id,
              externalUrl: `https://www.facebook.com/${id}`,
            };
          }

          const result = await graphJson<{ id: string }>(`${base}/${input.externalId}/feed`, {
            method: "POST",
            body: { message: input.caption },
          });

          return {
            status: "PUBLISHED",
            externalPostId: result.id,
            externalUrl: `https://www.facebook.com/${result.id}`,
          };
        }

        if (input.platform === "INSTAGRAM") {
          if (!input.imageUrl) {
            return { status: "TERMINAL_CONTENT", detail: "Instagram requires an image" };
          }

          let containerId = input.containerId ?? null;

          if (!containerId) {
            const container = await graphJson<{ id: string }>(`${base}/${input.externalId}/media`, {
              method: "POST",
              body: { image_url: input.imageUrl, caption: input.caption },
            });
            containerId = container.id;
          }

          for (let attempt = 0; attempt < 20; attempt += 1) {
            const status = await graphJson<{ status_code?: string; status?: string }>(
              `${base}/${containerId}?fields=status_code,status`,
            );

            if (status.status_code === "FINISHED" || status.status === "FINISHED") {
              break;
            }

            if (status.status_code === "ERROR" || status.status === "ERROR") {
              return { status: "TERMINAL_CONTENT", detail: "Instagram container failed" };
            }

            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }

          const published = await graphJson<{ id: string }>(
            `${base}/${input.externalId}/media_publish`,
            { method: "POST", body: { creation_id: containerId } },
          );

          return {
            status: "PUBLISHED",
            externalPostId: published.id,
            externalUrl: `https://www.instagram.com/p/${published.id}`,
          };
        }

        return { status: "TERMINAL_CONTENT", detail: "Platform is not enabled" };
      } catch (error) {
        return classifyMetaError(error);
      }
    },

    async fetchInsights(input: InsightQuery): Promise<InsightResult> {
      const metrics = "reach,views,accounts_engaged,saves,website_clicks";
      const url = new URL(`${base}/${input.externalId}/insights`);
      url.searchParams.set("metric", metrics);
      url.searchParams.set("since", String(Math.floor(input.since.getTime() / 1000)));
      url.searchParams.set("until", String(Math.floor(input.until.getTime() / 1000)));
      url.searchParams.set("access_token", input.accessToken);
      const raw = await graphJson<{ data?: { name: string; values?: { value?: number }[] }[] }>(
        url.toString(),
      );
      const mapped: Record<string, number | null> = {};

      for (const item of raw.data ?? []) {
        mapped[item.name] = item.values?.[0]?.value ?? null;
      }

      return {
        metrics: {
          reach: mapped.reach ?? null,
          views: mapped.views ?? null,
          engagements: mapped.accounts_engaged ?? null,
          followers: null,
          saves: mapped.saves ?? null,
          linkClicks: mapped.website_clicks ?? null,
        },
        raw: raw,
      };
    },

    async refresh(account) {
      if (!account.userToken) {
        return { accessToken: account.accessToken, refreshToken: null, expiresAt: null };
      }

      const result = await graphJson<{ access_token: string; expires_in?: number }>(
        `${base}/oauth/access_token?grant_type=fb_exchange_token&client_id=${options.appId}&client_secret=${options.appSecret}&fb_exchange_token=${account.userToken}`,
      );

      return {
        accessToken: result.access_token,
        refreshToken: null,
        expiresAt: result.expires_in
          ? new Date(Date.now() + result.expires_in * 1000)
          : null,
      };
    },

    async revoke(account) {
      try {
        await fetch(
          `${base}/${account.externalId}/permissions?access_token=${account.accessToken}`,
          { method: "DELETE", signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) },
        );
      } catch {
        return;
      }
    },
  };
}
