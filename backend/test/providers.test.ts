import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStorage } from "../src/providers/storage/local.js";
import { createFakePaymentProvider } from "../src/providers/payments/fake.js";
import { createFakeSocialPublisher } from "../src/providers/social/fake.js";
import { createFakePushProvider } from "../src/providers/push/fake.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("local storage", () => {
  it("stores files, signs uploads and verifies private media links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "redflie-storage-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const storage = createLocalStorage({
      baseDir: dir,
      publicBaseUrl: "http://localhost:3000",
      signingSecret: "test-signing-secret",
    });

    await storage.put("business/logo.png", Buffer.from("png"), "image/png");
    expect(await storage.exists("business/logo.png")).toBe(true);
    expect(await storage.get("business/logo.png")).toEqual(Buffer.from("png"));

    const upload = new URL(
      await storage.presignPut("business/logo.png", "image/png", 1024),
    );
    expect(upload.pathname).toBe("/v1/public/storage/business/logo.png");
    expect(
      storage.verifyUpload(
        "business/logo.png",
        upload.searchParams.get("expires") ?? "",
        upload.searchParams.get("signature") ?? "",
      ),
    ).toBe(true);
    expect(
      storage.verifyUpload(
        "business/other.png",
        upload.searchParams.get("expires") ?? "",
        upload.searchParams.get("signature") ?? "",
      ),
    ).toBe(false);

    const media = new URL(await storage.presignGet("business/logo.png", 60));
    expect(media.pathname).toBe("/v1/public/media/business/logo.png");
    expect(
      storage.verifyUpload(
        "business/logo.png",
        media.searchParams.get("expires") ?? "",
        media.searchParams.get("signature") ?? "",
      ),
    ).toBe(true);

    await expect(
      storage.put("../escape.txt", Buffer.from("x"), "text/plain"),
    ).rejects.toThrow();
    await storage.remove("business/logo.png");
    expect(await storage.exists("business/logo.png")).toBe(false);
  });
});

describe("fake payment provider", () => {
  it("records intents and returns scripted results", async () => {
    const provider = createFakePaymentProvider("ESEWA");
    const intent = {
      paymentId: "pay_1",
      purchaseOrderId: "order_1",
      amountPaisa: 150_000,
      taxPaisa: 0,
      planName: "Standard",
      returnUrl: "http://localhost/callback",
      successUrl: "http://localhost/success",
      failureUrl: "http://localhost/failure",
    };

    const initiated = await provider.initiate(intent);
    expect(provider.intents).toHaveLength(1);
    expect(initiated.type).toBe("REDIRECT");

    const confirmed = await provider.confirmReturn({}, intent);
    expect(confirmed.status).toBe("COMPLETED");
    expect(confirmed.amountPaisa).toBe(150_000);

    provider.setScript({
      statusResult: {
        status: "PENDING",
        providerRef: "ref",
        providerTxnId: null,
        amountPaisa: null,
        raw: {},
      },
    });
    expect((await provider.status({ ...intent, providerRef: "ref" })).status).toBe("PENDING");
  });
});

describe("fake social publisher", () => {
  it("supports OAuth, publishing, insights, refresh and revoke", async () => {
    const publisher = createFakeSocialPublisher("FACEBOOK");

    const oauth = await publisher.beginOAuth({
      businessId: "biz_1",
      userId: "user_1",
      platform: "FACEBOOK",
      state: "state_1",
      returnTo: "/settings",
    });
    expect(oauth.url).toContain("state=state_1");

    const accounts = await publisher.completeOAuth({
      code: "code",
      state: "state_1",
      redirectUri: "http://localhost/callback",
    });
    expect(accounts[0]?.externalId).toBe("facebook-test-1");

    const published = await publisher.publish({
      platform: "FACEBOOK",
      externalId: "facebook-test-1",
      accessToken: "token",
      caption: "Hello",
      format: "IMAGE",
    });
    expect(published.status).toBe("PUBLISHED");
    expect(publisher.calls.some((call) => call.operation === "publish")).toBe(true);

    expect((await publisher.fetchInsights({
      platform: "FACEBOOK",
      externalId: "facebook-test-1",
      accessToken: "token",
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
    })).metrics.reach).toBe(1200);

    expect((await publisher.refresh({
      accessToken: "token",
      refreshToken: null,
      userToken: null,
    })).accessToken).toContain("fake-refreshed");

    await expect(publisher.revoke({
      accessToken: "token",
      externalId: "facebook-test-1",
    })).resolves.toBeUndefined();
  });

  it("returns scripted publish failures and refresh errors", async () => {
    const publisher = createFakeSocialPublisher("INSTAGRAM", {
      publishResults: [
        { status: "LIMIT", retryAfterSec: 60, detail: "rate limited" },
      ],
    });

    const result = await publisher.publish({
      platform: "INSTAGRAM",
      externalId: "ig_1",
      accessToken: "token",
      caption: "Hello",
      format: "REEL",
    });
    expect(result).toEqual({ status: "LIMIT", retryAfterSec: 60, detail: "rate limited" });

    publisher.setScript({ refreshError: new Error("expired") });
    await expect(
      publisher.refresh({ accessToken: "token", refreshToken: "r", userToken: null }),
    ).rejects.toThrow("expired");
  });
});

describe("fake push provider", () => {
  it("records pushed messages", async () => {
    const push = createFakePushProvider();
    const result = await push.send(["token_1", "token_2"], {
      title: "Post approved",
      body: "Your post is ready",
      data: { postId: "post_1" },
    });

    expect(result).toEqual({ sent: 2, invalidTokens: [] });
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]?.message.title).toBe("Post approved");
  });
});
