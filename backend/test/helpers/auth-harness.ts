import { createAuthService, type AuthConfig } from "../../src/modules/auth/auth.service.js";
import { createMemoryRateLimiter } from "../../src/lib/rate-limit.js";
import { createMemoryRevocationStore } from "../../src/lib/revocations.js";
import { createTokenService } from "../../src/lib/tokens.js";
import { FakeSmsProvider } from "../../src/providers/sms/fake.js";
import { createImmediateSmsSender } from "../../src/providers/sms/queue.js";
import type { GoogleIdentity } from "../../src/providers/google.js";
import { createFakeRepo } from "./fake-repo.js";

export const IP = "203.0.113.10";
export const CONSENT = { termsVersion: "test-terms", privacyVersion: "test-privacy" };

export const baseConfig: AuthConfig = {
  otpPepper: "test-otp-pepper-at-least-thirty-two-characters",
  otpTtlSec: 300,
  timingFloorMs: 0,
  allowedCountryCodes: ["977"],
  smsDailyCap: 1000,
  termsVersion: "test-terms",
  privacyVersion: "test-privacy",
  accessTtlSec: 900,
  refreshSlidingDays: 30,
  refreshAbsoluteDays: 180,
  maxActiveSessions: 10,
  isProduction: false,
};

export function createHarness(overrides: { config?: Partial<AuthConfig> } = {}) {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(nowMs);
  const advance = (seconds: number) => {
    nowMs += seconds * 1000;
  };
  const fake = createFakeRepo();
  const limiter = createMemoryRateLimiter(() => nowMs);
  const revocations = createMemoryRevocationStore(() => nowMs);
  const smsProvider = new FakeSmsProvider();
  const sms = createImmediateSmsSender(smsProvider);
  const tokens = createTokenService({
    privateKeyBase64: process.env.JWT_PRIVATE_KEY!,
    publicKeysBase64: JSON.parse(process.env.JWT_PUBLIC_KEYS!) as Record<string, string>,
    kid: process.env.JWT_KID!,
    accessTtlSec: baseConfig.accessTtlSec,
  });
  const identities = new Map<string, GoogleIdentity>();
  const google = {
    async verify(token: string): Promise<GoogleIdentity> {
      const identity = identities.get(token);

      if (!identity) {
        throw new Error("Invalid Google token");
      }

      return identity;
    },
  };
  const captcha = {
    async verify(token: string): Promise<boolean> {
      return token === "captcha-ok";
    },
  };
  const alerts: string[] = [];
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const logs: { level: string; object: Record<string, unknown>; message: string }[] = [];
  const log = {
    info(object: Record<string, unknown>, message: string) {
      logs.push({ level: "info", object, message });
    },
    warn(object: Record<string, unknown>, message: string) {
      logs.push({ level: "warn", object, message });
    },
    error(object: Record<string, unknown>, message: string) {
      logs.push({ level: "error", object, message });
    },
  };
  const config: AuthConfig = { ...baseConfig, ...overrides.config };
  const service = createAuthService({
    repo: fake.repo,
    limiter,
    revocations,
    tokens,
    sms,
    google,
    captcha,
    config,
    log,
    alert(message) {
      alerts.push(message);
    },
    onEvent(type, payload) {
      emitted.push({ type, payload });
    },
    now: clock,
  });

  async function login(
    phone: string,
    device?: { name?: string; platform?: string },
    captchaToken?: string,
  ) {
    const challenge = await service.requestOtp(
      { phone, ...(captchaToken ? { captchaToken } : {}) },
      { ip: IP },
    );
    const code = smsProvider.lastCode();

    if (!code) {
      throw new Error("No SMS was sent");
    }

    const result = await service.verifyOtp(
      {
        challengeId: challenge.challengeId,
        code,
        consent: CONSENT,
        ...(device ? { device } : {}),
      },
      { ip: IP },
    );
    const claims = await tokens.verify(result.accessToken);

    return { ...result, sessionId: claims.sid, claims };
  }

  return {
    service,
    fake,
    limiter,
    revocations,
    smsProvider,
    tokens,
    identities,
    alerts,
    emitted,
    logs,
    config,
    advance,
    now: clock,
    login,
  };
}

export type Harness = ReturnType<typeof createHarness>;
