import { execFileSync, spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeSmsProvider } from "../src/providers/sms/fake.js";

const dockerAvailable =
  process.env.SKIP_TESTCONTAINERS !== "1" &&
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 }).status === 0;

const REFRESH_COOKIE = "__Host-rf_refresh";
const BACKEND = process.cwd();

type StartedContainers = {
  getHost(): string;
  getMappedPort(port: number): number;
  stop(): Promise<unknown>;
};

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header)
    ? header.join("\n")
    : typeof header === "string"
      ? header
      : "";
  const match = raw.match(new RegExp(`${REFRESH_COOKIE}=([^;]+)`));

  if (!match?.[1]) {
    throw new Error(`Missing ${REFRESH_COOKIE} cookie in ${raw}`);
  }

  return match[1];
}

describe.skipIf(!dockerAvailable)("auth API integration (Postgres + Redis)", () => {
  let app: FastifyInstance;
  let postgres: StartedContainers;
  let redis: StartedContainers;
  let fakeSms: FakeSmsProvider;
  const phone = "+9779800000001";

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import("testcontainers");

    postgres = await new GenericContainer("postgres:17-alpine")
      .withEnvironment({
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: "postgres",
        POSTGRES_DB: "postgres",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections", 2),
      )
      .start();

    redis = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const databaseUrl = `postgresql://postgres:postgres@${postgres.getHost()}:${postgres.getMappedPort(
      5432,
    )}/postgres?schema=public`;
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
      cwd: BACKEND,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });

    fakeSms = new (await import("../src/providers/sms/fake.js")).FakeSmsProvider();

    const { createImmediateSmsSender } = await import("../src/providers/sms/queue.js");
    const { buildApp } = await import("../src/app.js");

    app = await buildApp({
      databaseUrl,
      redisUrl,
      useRedis: true,
      auth: { sms: createImmediateSmsSender(fakeSms) },
    });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
  }, 60_000);

  it("runs the full OTP, refresh, session and logout-all flow", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/v1/app/auth/me" });

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({ code: "UNAUTHORIZED" });

    const requested = await app.inject({
      method: "POST",
      url: "/v1/app/auth/otp/request",
      payload: { phone },
    });

    expect(requested.statusCode).toBe(202);
    const challenge = requested.json<{ challengeId: string }>();
    const code = fakeSms.lastCode();

    expect(code).toMatch(/^\d{6}$/);

    const verified = await app.inject({
      method: "POST",
      url: "/v1/app/auth/otp/verify",
      headers: { "user-agent": "integration-test", "x-client": "web" },
      payload: {
        challengeId: challenge.challengeId,
        code,
        consent: { termsVersion: "test-terms", privacyVersion: "test-privacy" },
        device: { name: "integration", platform: "WEB" },
      },
    });

    expect(verified.statusCode).toBe(200);
    const login = verified.json<{
      accessToken: string;
      refreshToken?: string;
      user: { id: string; phone: string };
      isNewUser: boolean;
    }>();

    expect(login.isNewUser).toBe(true);
    expect(login.user.phone).toBe(phone);
    expect(login.refreshToken).toBeUndefined();

    const setCookie = String(verified.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const me = await app.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${login.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ data: { id: login.user.id, phone } });

    const refreshToken = cookieFrom(verified);

    const noOrigin = await app.inject({
      method: "POST",
      url: "/v1/app/auth/refresh",
      headers: { cookie: `${REFRESH_COOKIE}=${refreshToken}` },
      payload: {},
    });

    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json()).toMatchObject({ code: "AUTH_ORIGIN_NOT_ALLOWED" });

    const refreshed = await app.inject({
      method: "POST",
      url: "/v1/app/auth/refresh",
      headers: {
        cookie: `${REFRESH_COOKIE}=${refreshToken}`,
        origin: "http://localhost:3001",
        "x-requested-with": "XMLHttpRequest",
      },
      payload: {},
    });

    expect(refreshed.statusCode).toBe(200);
    const refreshedBody = refreshed.json<{ accessToken: string }>();
    expect(refreshedBody.accessToken).toBeTruthy();

    const raced = await app.inject({
      method: "POST",
      url: "/v1/app/auth/refresh",
      headers: {
        cookie: `${REFRESH_COOKIE}=${refreshToken}`,
        origin: "http://localhost:3001",
        "x-requested-with": "XMLHttpRequest",
      },
      payload: {},
    });

    expect(raced.statusCode).toBe(409);
    expect(raced.json()).toMatchObject({ code: "AUTH_REFRESH_RACE" });

    const sessions = await app.inject({
      method: "GET",
      url: "/v1/app/auth/sessions",
      headers: { authorization: `Bearer ${refreshedBody.accessToken}` },
    });

    expect(sessions.statusCode).toBe(200);
    expect(sessions.json<{ data: { current: boolean }[] }>().data).toHaveLength(1);

    const cooldown = await app.inject({
      method: "POST",
      url: "/v1/app/auth/otp/request",
      payload: { phone },
    });

    expect(cooldown.statusCode).toBe(429);
    expect(cooldown.headers["retry-after"]).toBeDefined();
    expect(cooldown.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });

    const logoutAll = await app.inject({
      method: "POST",
      url: "/v1/app/auth/logout-all",
      headers: { authorization: `Bearer ${refreshedBody.accessToken}` },
    });

    expect(logoutAll.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/v1/app/auth/me",
      headers: { authorization: `Bearer ${refreshedBody.accessToken}` },
    });

    expect(afterLogout.statusCode).toBe(401);

    const dbUser = await app.prisma.user.findUnique({ where: { phoneE164: phone } });
    const dbSession = await app.prisma.session.findFirst({
      where: { userId: login.user.id },
    });

    expect(dbUser?.tokenVersion).toBe(1);
    expect(dbSession?.revokedAt).not.toBeNull();
  });
});
