import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ADMIN_COOKIE } from "../src/plugins/admin.js";
import { createFakeRepo } from "./helpers/fake-repo.js";
import {
  createStaffHarness,
  IP,
  STRONG_PASSWORD,
  UA,
  type StaffHarness,
} from "./helpers/staff-harness.js";

const ORIGIN = "http://localhost:3001";

let app: FastifyInstance | undefined;
let harness: StaffHarness | undefined;

async function setup(): Promise<{ app: FastifyInstance; harness: StaffHarness }> {
  harness = createStaffHarness();
  app = await buildApp({
    useRedis: false,
    runtimeRole: "admin-api",
    admin: {
      repo: harness.repo,
      audit: harness.auditRepo.repo,
      email: harness.email,
      limiter: harness.limiter,
      oneTimeTokens: harness.oneTimeTokens,
      cache: harness.cache,
      passwordHasher: harness.passwordHasher,
      totp: harness.totp,
      secretBox: harness.secretBox,
      preAuth: harness.preAuth,
      tokens: harness.tokens,
      now: harness.now,
    },
  });
  await app.ready();

  return { app, harness };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  harness = undefined;
});

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? raw.join(";")
    : typeof raw === "string"
      ? raw
      : "";
  const match = cookies.match(new RegExp(`${ADMIN_COOKIE}=([^;]+)`));

  if (!match) {
    throw new Error(`No ${ADMIN_COOKIE} cookie returned`);
  }

  return `${ADMIN_COOKIE}=${match[1]}`;
}

async function login(
  instance: FastifyInstance,
  harness: StaffHarness,
  secret: string,
  email = "admin@example.com",
  userAgent = UA,
) {
  const started = await instance.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: STRONG_PASSWORD },
    remoteAddress: IP,
  });

  expect(started.statusCode).toBe(200);

  const mfaToken = started.json<{ mfaToken: string }>().mfaToken;
  const code = await harness.totp.code(secret);
  const verified = await instance.inject({
    method: "POST",
    url: "/v1/admin/auth/mfa/verify",
    payload: { mfaToken, code },
    headers: { "user-agent": userAgent },
    remoteAddress: IP,
  });

  expect(verified.statusCode).toBe(200);

  const body = verified.json<{ csrfToken: string }>();

  return {
    cookie: sessionCookie(verified),
    csrfToken: body.csrfToken,
    headers: {
      cookie: sessionCookie(verified),
      origin: ORIGIN,
      "x-csrf-token": body.csrfToken,
      "user-agent": userAgent,
    },
  };
}

describe("admin routes", () => {
  it("requires a session and disables caching", async () => {
    const { app: instance } = await setup();
    const unauthorized = await instance.inject({
      method: "GET",
      url: "/v1/admin/auth/me",
      remoteAddress: IP,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
  });

  it("rejects mutations without CSRF and with the wrong origin", async () => {
    const { app: instance, harness: h } = await setup();
    const { secret } = await h.seedStaff({ mfa: true });
    const session = await login(instance, h, secret!);

    const noCsrf = await instance.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "user-agent": UA,
      },
      remoteAddress: IP,
    });
    const wrongOrigin = await instance.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: {
        cookie: session.cookie,
        origin: "https://evil.example.com",
        "x-csrf-token": session.csrfToken,
        "user-agent": UA,
      },
      remoteAddress: IP,
    });

    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ code: "CSRF_INVALID" });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toMatchObject({ code: "AUTH_ORIGIN_NOT_ALLOWED" });

    const ok = await instance.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: session.headers,
      remoteAddress: IP,
    });

    expect(ok.statusCode).toBe(204);

    const me = await instance.inject({
      method: "GET",
      url: "/v1/admin/auth/me",
      headers: { cookie: session.cookie, "user-agent": UA },
      remoteAddress: IP,
    });

    expect(me.statusCode).toBe(401);
  });

  it("revokes a session when the user agent changes", async () => {
    const { app: instance, harness: h } = await setup();
    const { staff, secret } = await h.seedStaff({ mfa: true });
    const session = await login(instance, h, secret!, "admin@example.com", "agent-a");

    const me = await instance.inject({
      method: "GET",
      url: "/v1/admin/auth/me",
      headers: { cookie: session.cookie, "user-agent": "agent-b" },
      remoteAddress: IP,
    });

    expect(me.statusCode).toBe(401);

    const sessions = [...h.store.sessions.values()];

    expect(sessions[0]?.revokedAt).not.toBeNull();
    expect(sessions[0]?.revokeReason).toBe("user_agent_mismatch");
    expect(sessions[0]?.staffId).toBe(staff.id);
  });

  it("expires sessions after the idle window", async () => {
    const { app: instance, harness: h } = await setup();
    const { secret } = await h.seedStaff({ mfa: true });
    const session = await login(instance, h, secret!);

    h.advance(30 * 60 + 1);

    const me = await instance.inject({
      method: "GET",
      url: "/v1/admin/auth/me",
      headers: { cookie: session.cookie, "user-agent": UA },
      remoteAddress: IP,
    });

    expect(me.statusCode).toBe(401);
  });

  it("enforces permissions and step-up before staff management", async () => {
    const { app: instance, harness: h } = await setup();
    const { secret } = await h.seedStaff({
      email: "ops@example.com",
      role: "OPS",
      mfa: true,
    });
    const opsSession = await login(instance, h, secret!, "ops@example.com");

    const forbidden = await instance.inject({
      method: "GET",
      url: "/v1/admin/staff",
      headers: { cookie: opsSession.cookie, "user-agent": UA },
      remoteAddress: IP,
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "FORBIDDEN" });

    const { secret: adminSecret } = await h.seedStaff({ mfa: true });
    h.advance(30);
    const adminSession = await login(instance, h, adminSecret!);

    const noStepUp = await instance.inject({
      method: "POST",
      url: "/v1/admin/staff/invite",
      headers: adminSession.headers,
      payload: { email: "new@example.com", role: "SUPPORT" },
      remoteAddress: IP,
    });

    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });

    const stepUp = await instance.inject({
      method: "POST",
      url: "/v1/admin/auth/step-up",
      headers: adminSession.headers,
      payload: {
        password: STRONG_PASSWORD,
        code: await h.totp.code(adminSecret!),
      },
      remoteAddress: IP,
    });

    expect(stepUp.statusCode).toBe(200);

    const invited = await instance.inject({
      method: "POST",
      url: "/v1/admin/staff/invite",
      headers: adminSession.headers,
      payload: { email: "new@example.com", role: "SUPPORT" },
      remoteAddress: IP,
    });

    expect(invited.statusCode).toBe(200);
    expect(invited.json<{ data: { email: string } }>().data.email).toBe(
      "new@example.com",
    );
  });

  it("blocks non-GET requests with an impersonation token", async () => {
    const fakeAuth = createFakeRepo();
    const user = await fakeAuth.repo.createUser({
      phoneE164: "+9779812345678",
      phoneVerifiedAt: new Date(),
    });
    const local = createStaffHarness();
    const token = await local.tokens.signImpersonation({
      userId: user.id,
      staffId: "staff-1",
      staffEmail: "admin@example.com",
      reason: "Investigating a support ticket",
    });
    const instance = await buildApp({
      useRedis: false,
      auth: { repo: fakeAuth.repo },
    });
    await instance.ready();

    try {
      const read = await instance.inject({
        method: "GET",
        url: "/v1/app/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      const write = await instance.inject({
        method: "POST",
        url: "/v1/app/auth/logout",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(read.statusCode).toBe(200);
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({ code: "IMPERSONATION_READ_ONLY" });
    } finally {
      await instance.close();
    }
  });
});
