import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTokenService } from "../src/lib/tokens.js";
import { FakeSmsProvider } from "../src/providers/sms/fake.js";
import { createImmediateSmsSender } from "../src/providers/sms/queue.js";
import { createFakeRepo, type FakeRepo } from "./helpers/fake-repo.js";

const CONSENT = { termsVersion: "test-terms", privacyVersion: "test-privacy" };
const PHONE = "+9779812345678";
const MOBILE = { "x-client": "mobile" };
const COOKIE = "__Host-rf_refresh";

let app: FastifyInstance | undefined;

async function setup(): Promise<{ app: FastifyInstance; fake: FakeRepo; sms: FakeSmsProvider }> {
  const fake = createFakeRepo();
  const sms = new FakeSmsProvider();
  app = await buildApp({
    auth: {
      repo: fake.repo,
      sms: createImmediateSmsSender(sms),
    },
  });
  await app.ready();

  return { app, fake, sms };
}

async function loginMobile(instance: FastifyInstance, sms: FakeSmsProvider, phone = PHONE) {
  const requested = await instance.inject({
    method: "POST",
    url: "/v1/app/auth/otp/request",
    payload: { phone },
  });
  const code = sms.lastCode();

  if (!code) {
    throw new Error("No OTP sent");
  }

  const verified = await instance.inject({
    method: "POST",
    url: "/v1/app/auth/otp/verify",
    headers: MOBILE,
    payload: {
      challengeId: requested.json<{ challengeId: string }>().challengeId,
      code,
      consent: CONSENT,
    },
  });

  expect(verified.statusCode).toBe(200);

  return verified.json<{ accessToken: string; refreshToken: string; user: { id: string } }>();
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("auth routes", () => {
  it("returns problem+json errors for unauthenticated and invalid requests", async () => {
    const { app: instance } = await setup();

    const unauthorized = await instance.inject({ method: "GET", url: "/v1/app/auth/me" });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["content-type"]).toContain("application/problem+json");
    expect(unauthorized.json()).toMatchObject({ code: "UNAUTHORIZED" });

    const invalidPhone = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/otp/request",
      payload: { phone: "123" },
    });

    expect(invalidPhone.statusCode).toBe(400);
    expect(invalidPhone.json()).toMatchObject({ code: "AUTH_INVALID_PHONE" });

    const missing = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/otp/verify",
      payload: {},
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("authenticates /me, updates the profile and revokes on logout", async () => {
    const { app: instance, sms } = await setup();
    const login = await loginMobile(instance, sms);

    const me = await instance.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { phone: PHONE, id: login.user.id } });

    const updated = await instance.inject({
      method: "PATCH",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { name: "Anish", locale: "EN" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ data: { name: "Anish", locale: "EN" } });

    const sessions = await instance.inject({
      method: "GET",
      url: "/v1/app/auth/sessions",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(sessions.statusCode).toBe(200);
    expect(sessions.json<{ data: unknown[] }>().data).toHaveLength(1);

    const logout = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/logout",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(logout.statusCode).toBe(204);

    const afterLogout = await instance.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(afterLogout.statusCode).toBe(401);
  });

  it("logout-all bumps tokenVersion and invalidates access tokens", async () => {
    const { app: instance, fake, sms } = await setup();
    const login = await loginMobile(instance, sms);

    const logout = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/logout-all",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(logout.statusCode).toBe(204);

    const user = await fake.repo.findUserById(login.user.id);

    expect(user?.tokenVersion).toBe(1);

    const me = await instance.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(me.statusCode).toBe(401);
  });

  it("rejects suspended accounts with 403", async () => {
    const { app: instance, fake, sms } = await setup();
    const login = await loginMobile(instance, sms);

    await fake.repo.updateUser(login.user.id, { status: "SUSPENDED" });

    const me = await instance.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(me.statusCode).toBe(403);
    expect(me.json()).toMatchObject({ code: "ACCOUNT_SUSPENDED" });
  });

  it("uses a secure web cookie and enforces the refresh origin", async () => {
    const { app: instance, sms } = await setup();
    const requested = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/otp/request",
      payload: { phone: PHONE },
    });
    const code = sms.lastCode()!;

    const verified = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/otp/verify",
      payload: {
        challengeId: requested.json<{ challengeId: string }>().challengeId,
        code,
        consent: CONSENT,
      },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ refreshToken?: string }>().refreshToken).toBeUndefined();

    const setCookie = String(verified.headers["set-cookie"]);
    const token = setCookie.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];

    expect(token).toBeTruthy();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");

    const missingOrigin = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/refresh",
      headers: { cookie: `${COOKIE}=${token}` },
      payload: {},
    });

    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toMatchObject({ code: "AUTH_ORIGIN_NOT_ALLOWED" });

    const refreshed = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/refresh",
      headers: {
        cookie: `${COOKIE}=${token}`,
        origin: "http://localhost:3001",
        "x-requested-with": "XMLHttpRequest",
      },
      payload: {},
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.headers["set-cookie"]).toBeTruthy();

    const reused = await instance.inject({
      method: "POST",
      url: "/v1/app/auth/refresh",
      headers: {
        cookie: `${COOKIE}=${token}`,
        origin: "http://localhost:3001",
        "x-requested-with": "XMLHttpRequest",
      },
      payload: {},
    });

    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: "AUTH_REFRESH_RACE" });
  });

  it("rejects restricted Google tokens on app routes", async () => {
    const { app: instance } = await setup();
    const tokens = createTokenService({
      privateKeyBase64: process.env.JWT_PRIVATE_KEY!,
      publicKeysBase64: JSON.parse(process.env.JWT_PUBLIC_KEYS!) as Record<string, string>,
      kid: process.env.JWT_KID!,
      accessTtlSec: 900,
    });
    const restricted = await tokens.signRestricted({ sub: "google-user" });

    const me = await instance.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${restricted}` },
    });

    expect(me.statusCode).toBe(401);
  });
});
