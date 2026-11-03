import { randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { hashToken } from "../../lib/crypto.js";
import { hmacHex } from "../../lib/hmac.js";
import { ipInCidr } from "../../lib/ip.js";
import { OTP_LENGTH, buildOtpSmsText, generateOtpCode, hashOtpCode, otpCodeMatches } from "../../lib/otp.js";
import { maskIp, maskPhone, normalizePhone } from "../../lib/phone.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import type { RevocationStore } from "../../lib/revocations.js";
import type { RestrictedIdentity, TokenService } from "../../lib/tokens.js";
import type { GoogleIdentity, GoogleVerifier } from "../../providers/google.js";
import type { SmsAlert, SmsPurpose, SmsSender } from "../../providers/sms/types.js";
import type { CaptchaVerifier } from "../../providers/turnstile.js";
import {
  UniqueConflictError,
  type AuthRepo,
  type ChallengeRecord,
  type DeviceInfo,
  type RequestContext,
  type SecurityEventInput,
  type SessionRecord,
  type UserRecord,
} from "./auth.types.js";

const RESEND_COOLDOWN_SEC = 45;
const PHONE_SENDS_PER_15M = 3;
const PHONE_SENDS_PER_DAY = 8;
const IP_SENDS_PER_HOUR = 20;
const VERIFY_PER_IP_15M = 60;
const REFRESH_PER_SESSION_MIN = 30;
const CAPTCHA_AFTER_IP_REQUESTS = 3;
const REFRESH_RACE_MS = 10_000;
const DAY_SEC = 86_400;

export type AuthConfig = {
  otpPepper: string;
  otpTtlSec: number;
  timingFloorMs: number;
  otpDevBypass?: string;
  allowedCountryCodes: string[];
  smsDailyCap: number;
  androidSmsHash?: string;
  termsVersion: string;
  privacyVersion: string;
  accessTtlSec: number;
  refreshSlidingDays: number;
  refreshAbsoluteDays: number;
  maxActiveSessions: number;
  isProduction: boolean;
};

type Log = {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

export type AuthServiceDeps = {
  repo: AuthRepo;
  limiter: RateLimiter;
  revocations: RevocationStore;
  tokens: TokenService;
  sms: SmsSender;
  google: GoogleVerifier;
  captcha: CaptchaVerifier;
  config: AuthConfig;
  log: Log;
  alert?: SmsAlert;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  now?: () => Date;
};

export type AuthUser = {
  id: string;
  phone: string;
  email: string | null;
  name: string | null;
  locale: "NE" | "EN";
  status: string;
  hasGoogle: boolean;
};

export type ConsentInput = {
  termsVersion: string;
  privacyVersion: string;
};

export type IssuedLogin = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
  isNewUser: boolean;
  deletionPending: boolean;
};

export type RefreshResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type RequestOtpResult = {
  challengeId: string;
  resendAfterSec: number;
  expiresInSec: number;
};

export type SessionView = {
  id: string;
  deviceName: string | null;
  platform: string | null;
  lastUsedAt: Date | null;
  ipMasked: string | null;
  current: boolean;
};

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function rateLimited(retryAfterSec: number): AppError {
  return new AppError(429, "AUTH_RATE_LIMITED", "Too many requests, try again later", {
    retryAfterSec: Math.max(retryAfterSec, 1),
  });
}

function invalidOtp(): AppError {
  return new AppError(401, "AUTH_INVALID_OTP", "Invalid or expired code");
}

function assertConsent(config: AuthConfig, consent: ConsentInput): void {
  if (
    consent.termsVersion !== config.termsVersion ||
    consent.privacyVersion !== config.privacyVersion
  ) {
    throw new AppError(
      400,
      "AUTH_CONSENT_REQUIRED",
      "Accept the current terms of service and privacy policy",
    );
  }
}

export function createAuthService(deps: AuthServiceDeps) {
  const { repo, limiter, revocations, tokens, config } = deps;
  const clock = deps.now ?? (() => new Date());

  function phoneHash(phone: string): string {
    return hmacHex(config.otpPepper, phone);
  }

  function toAuthUser(user: UserRecord): AuthUser {
    return {
      id: user.id,
      phone: user.phoneE164,
      email: user.email,
      name: user.name,
      locale: user.locale,
      status: user.status,
      hasGoogle: user.googleSub !== null,
    };
  }

  async function recordEvent(
    type: string,
    result: SecurityEventInput["result"],
    ctx: RequestContext,
    options: {
      userId?: string | null;
      phone?: string | null;
      meta?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    try {
      await repo.createSecurityEvent({
        type,
        result,
        userId: options.userId,
        phoneHash: options.phone ? phoneHash(options.phone) : null,
        phoneMasked: options.phone ? maskPhone(options.phone) : null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        meta: options.meta,
      });
    } catch (error) {
      deps.log.error({ err: error, eventType: type }, "Failed to write security event");
    }
  }

  function emit(type: string, payload: Record<string, unknown>): void {
    try {
      deps.onEvent?.(type, payload);
    } catch (error) {
      deps.log.error({ err: error, eventType: type }, "Event handler failed");
    }
  }

  async function isDenied(phone: string, ctx: RequestContext): Promise<boolean> {
    if (await repo.isDenied("PHONE", phone, clock())) {
      return true;
    }

    if (ctx.ip && (await repo.isDenied("IP", ctx.ip, clock()))) {
      return true;
    }

    if (ctx.ip) {
      const cidrs = await repo.listActiveCidrs(clock());

      if (cidrs.some((cidr) => ipInCidr(ctx.ip ?? "", cidr))) {
        return true;
      }
    }

    return false;
  }

  async function captchaRequiredFor(ip: string | undefined, now: Date): Promise<boolean> {
    const day = utcDay(now);
    const spend = await limiter.get(`sms:${day}:spend`);
    const forced = (await limiter.get(`sms:${day}:captcha-force`)) > 0;
    const byIp = ip ? (await limiter.get(`captcha:ip:${ip}`)) >= CAPTCHA_AFTER_IP_REQUESTS : false;

    return forced || spend >= config.smsDailyCap || byIp;
  }

  async function verifyCaptcha(token: string | undefined, ctx: RequestContext): Promise<boolean> {
    if (!token) {
      return false;
    }

    return deps.captcha.verify(token, ctx.ip);
  }

  async function enforceRateLimit(
    key: string,
    limit: number,
    windowSec: number,
    ctx: RequestContext,
    eventType: string,
  ): Promise<void> {
    const result = await limiter.hit(key, limit, windowSec);

    if (!result.allowed) {
      await recordEvent(eventType, "BLOCKED", ctx, {
        meta: { limit, windowSec, retryAfterSec: result.retryAfterSec },
      });
      throw rateLimited(result.retryAfterSec);
    }
  }

  async function padResponse(startedAt: number): Promise<void> {
    const remaining = config.timingFloorMs - (Date.now() - startedAt);

    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  async function requestChallenge(
    input: {
      phone: string;
      purpose: SmsPurpose;
      userId?: string | null;
      captchaToken?: string;
    },
    ctx: RequestContext,
  ): Promise<RequestOtpResult> {
    const startedAt = Date.now();
    const now = clock();
    const phone = normalizePhone(input.phone, config.allowedCountryCodes);

    if (!phone) {
      throw new AppError(400, "AUTH_INVALID_PHONE", "Enter a valid Nepali mobile number");
    }

    if (await isDenied(phone, ctx)) {
      await recordEvent("OTP_REQUESTED", "BLOCKED", ctx, {
        phone,
        meta: { reason: "denylist", purpose: input.purpose },
      });
      await padResponse(startedAt);

      return {
        challengeId: randomUUID(),
        resendAfterSec: RESEND_COOLDOWN_SEC,
        expiresInSec: config.otpTtlSec,
      };
    }

    const ipKey = ctx.ip ?? "unknown";
    const ipCaptchaCount = ctx.ip ? await limiter.increment(`captcha:ip:${ctx.ip}`, 3600) : 0;
    const captchaRequired =
      (await captchaRequiredFor(ctx.ip, now)) || ipCaptchaCount > CAPTCHA_AFTER_IP_REQUESTS;

    if (captchaRequired && !(await verifyCaptcha(input.captchaToken, ctx))) {
      await recordEvent("OTP_REQUESTED", "BLOCKED", ctx, {
        phone,
        meta: { reason: "captcha", purpose: input.purpose },
      });
      throw new AppError(403, "AUTH_CAPTCHA_REQUIRED", "Complete the CAPTCHA to continue");
    }

    const phoneKey = phoneHash(phone);

    await enforceRateLimit(
      `otp:cooldown:${phoneKey}`,
      1,
      RESEND_COOLDOWN_SEC,
      ctx,
      "OTP_REQUESTED",
    );
    await enforceRateLimit(
      `otp:send:phone:15m:${phoneKey}`,
      PHONE_SENDS_PER_15M,
      900,
      ctx,
      "OTP_REQUESTED",
    );
    await enforceRateLimit(
      `otp:send:phone:day:${phoneKey}`,
      PHONE_SENDS_PER_DAY,
      DAY_SEC,
      ctx,
      "OTP_REQUESTED",
    );
    await enforceRateLimit(
      `otp:send:ip:hour:${ipKey}`,
      IP_SENDS_PER_HOUR,
      3600,
      ctx,
      "OTP_REQUESTED",
    );

    const existing = await repo.findUserByPhone(phone);
    const hasAccount = existing !== null && existing.status !== "DELETED";
    const challengeId = randomUUID();
    const code = generateOtpCode();
    const codeHash = hashOtpCode(config.otpPepper, phone, code, challengeId);

    await repo.createChallenge({
      id: challengeId,
      phoneE164: phone,
      purpose: input.purpose,
      codeHash,
      userId: input.userId ?? existing?.id ?? null,
      ip: ctx.ip ?? null,
      expiresAt: new Date(now.getTime() + config.otpTtlSec * 1000),
    });

    const day = utcDay(now);
    const spendKey = `sms:${day}:spend`;
    const forceKey = `sms:${day}:captcha-force`;
    const spend = await limiter.get(spendKey);
    const forced = (await limiter.get(forceKey)) > 0;
    let shouldSend = true;

    if (forced || spend >= config.smsDailyCap) {
      shouldSend = hasAccount;
    } else {
      const budget = await limiter.consumeDaily(spendKey, config.smsDailyCap);

      if (!budget.allowed) {
        await limiter.increment(forceKey, DAY_SEC);
        shouldSend = hasAccount;
      } else if (budget.count / config.smsDailyCap >= 0.7) {
        const alertCount = await limiter.increment(`sms:${day}:alert-70`, DAY_SEC);

        if (alertCount === 1) {
          deps.alert?.("SMS daily budget has reached 70%", {
            count: budget.count,
            cap: config.smsDailyCap,
          });
        }
      }
    }

    if (shouldSend) {
      try {
        await deps.sms.enqueue({
          to: phone,
          text: buildOtpSmsText(code, config.androidSmsHash),
          purpose: input.purpose,
          ref: challengeId,
        });
      } catch (error) {
        deps.log.error({ err: error, purpose: input.purpose }, "Failed to enqueue OTP SMS");
        await recordEvent("OTP_REQUESTED", "FAIL", ctx, {
          phone,
          userId: input.userId ?? existing?.id ?? null,
          meta: { reason: "sms_enqueue_failed" },
        });
      }
    }

    await recordEvent("OTP_REQUESTED", "OK", ctx, {
      phone,
      userId: input.userId ?? existing?.id ?? null,
      meta: { purpose: input.purpose, sent: shouldSend },
    });
    await padResponse(startedAt);

    return {
      challengeId,
      resendAfterSec: RESEND_COOLDOWN_SEC,
      expiresInSec: config.otpTtlSec,
    };
  }

  async function takeChallenge(
    challengeId: string,
    purpose: SmsPurpose,
    code: string,
    ctx: RequestContext,
  ): Promise<ChallengeRecord> {
    const now = clock();
    const challenge = await repo.findChallenge(challengeId);

    if (!challenge || challenge.purpose !== purpose) {
      await recordEvent("OTP_FAILED", "FAIL", ctx, { meta: { reason: "unknown_challenge" } });
      throw invalidOtp();
    }

    if (challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= 5) {
      await recordEvent("OTP_FAILED", "FAIL", ctx, {
        phone: challenge.phoneE164,
        userId: challenge.userId,
        meta: { reason: "expired_consumed_or_locked" },
      });
      throw invalidOtp();
    }

    const latest = await repo.findLatestChallenge(challenge.phoneE164, purpose);

    if (latest?.id !== challenge.id) {
      await recordEvent("OTP_FAILED", "FAIL", ctx, {
        phone: challenge.phoneE164,
        userId: challenge.userId,
        meta: { reason: "not_newest" },
      });
      throw invalidOtp();
    }

    const attempts = await repo.incrementChallengeAttempts(challenge.id);
    const devBypass =
      !config.isProduction && config.otpDevBypass !== undefined && code === config.otpDevBypass;
    const matches =
      devBypass ||
      otpCodeMatches(
        challenge.codeHash,
        hashOtpCode(config.otpPepper, challenge.phoneE164, code, challenge.id),
      );

    if (!matches) {
      if (attempts >= 5) {
        await repo.consumeChallenge(challenge.id, now);
      }

      await recordEvent("OTP_FAILED", "FAIL", ctx, {
        phone: challenge.phoneE164,
        userId: challenge.userId,
        meta: { attempts },
      });
      throw invalidOtp();
    }

    await repo.consumeChallenge(challenge.id, now);

    return challenge;
  }

  async function enforceSessionLimit(userId: string, now: Date): Promise<void> {
    while ((await repo.countActiveFamilies(userId, now)) >= config.maxActiveSessions) {
      const oldest = await repo.oldestActiveFamily(userId, now);

      if (!oldest) {
        break;
      }

      const ids = await repo.revokeFamily(oldest, "session_limit", now);

      for (const id of ids) {
        await revocations.revoke(id, config.accessTtlSec);
      }
    }
  }

  async function issueSession(
    user: UserRecord,
    device: DeviceInfo | undefined,
    ctx: RequestContext,
    now: Date,
    options: {
      familyId?: string;
      absoluteExpiresAt?: Date;
    } = {},
  ) {
    if (!options.familyId) {
      await enforceSessionLimit(user.id, now);
    }

    const refreshToken = randomBytes(32).toString("base64url");
    const absoluteExpiresAt =
      options.absoluteExpiresAt ?? new Date(now.getTime() + config.refreshAbsoluteDays * DAY_SEC * 1000);
    const slidingExpiresAt = new Date(now.getTime() + config.refreshSlidingDays * DAY_SEC * 1000);
    const expiresAt = slidingExpiresAt < absoluteExpiresAt ? slidingExpiresAt : absoluteExpiresAt;
    const session = await repo.createSession({
      userId: user.id,
      familyId: options.familyId ?? randomUUID(),
      tokenHash: hashToken(refreshToken),
      deviceName: device?.name ?? null,
      platform: device?.platform ?? null,
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip ?? null,
      expiresAt,
      absoluteExpiresAt,
      lastUsedAt: now,
    });
    const accessToken = await tokens.signFull({
      userId: user.id,
      sessionId: session.id,
      tokenVersion: user.tokenVersion,
    });

    return { session, accessToken, refreshToken, expiresIn: config.accessTtlSec };
  }

  async function completeLogin(
    user: UserRecord,
    isNewUser: boolean,
    consent: ConsentInput,
    device: DeviceInfo | undefined,
    ctx: RequestContext,
  ): Promise<IssuedLogin> {
    const now = clock();
    const newDevice =
      !isNewUser && device !== undefined && !(await repo.hasSeenDevice(user.id, device));
    const updated = await repo.updateUser(user.id, { lastLoginAt: now });
    await repo.createConsents({
      userId: user.id,
      termsVersion: consent.termsVersion,
      privacyVersion: consent.privacyVersion,
      ip: ctx.ip,
      acceptedAt: now,
    });

    const issued = await issueSession(updated, device, ctx, now);

    await recordEvent("LOGIN_SUCCESS", "OK", ctx, {
      userId: user.id,
      phone: user.phoneE164,
      meta: { newDevice, newUser: isNewUser },
    });

    if (newDevice) {
      await recordEvent("NEW_DEVICE_LOGIN", "OK", ctx, {
        userId: user.id,
        phone: user.phoneE164,
        meta: { deviceName: device?.name, platform: device?.platform },
      });
      emit("NEW_DEVICE_LOGIN", {
        userId: user.id,
        deviceName: device?.name ?? null,
        platform: device?.platform ?? null,
      });
    }

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      user: toAuthUser(updated),
      isNewUser,
      deletionPending: updated.status === "DELETION_PENDING",
    };
  }

  async function findOrCreateUser(phone: string): Promise<{ user: UserRecord; isNewUser: boolean }> {
    const existing = await repo.findUserByPhone(phone);

    if (existing && existing.status !== "DELETED") {
      if (existing.status === "SUSPENDED") {
        throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
      }

      return { user: existing, isNewUser: false };
    }

    try {
      const user = await repo.createUser({
        phoneE164: phone,
        phoneVerifiedAt: clock(),
      });

      return { user, isNewUser: true };
    } catch (error) {
      if (error instanceof UniqueConflictError) {
        throw invalidOtp();
      }

      throw error;
    }
  }

  async function enforceVerifyIpLimit(ctx: RequestContext): Promise<void> {
    await enforceRateLimit(
      `otp:verify:ip:${ctx.ip ?? "unknown"}`,
      VERIFY_PER_IP_15M,
      900,
      ctx,
      "OTP_FAILED",
    );
  }

  return {
    async requestOtp(
      input: { phone: string; captchaToken?: string },
      ctx: RequestContext,
    ): Promise<RequestOtpResult> {
      return requestChallenge({ ...input, purpose: "LOGIN" }, ctx);
    },

    async verifyOtp(
      input: {
        challengeId: string;
        code: string;
        consent: ConsentInput;
        device?: DeviceInfo;
      },
      ctx: RequestContext,
      restricted?: RestrictedIdentity,
    ): Promise<IssuedLogin> {
      assertConsent(config, input.consent);
      await enforceVerifyIpLimit(ctx);
      const purpose: SmsPurpose = restricted ? "GOOGLE_ATTACH" : "LOGIN";
      const challenge = await takeChallenge(input.challengeId, purpose, input.code, ctx);

      if (restricted) {
        const existing = await repo.findUserByPhone(challenge.phoneE164);

        if (existing?.status === "SUSPENDED") {
          throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
        }

        if (existing && existing.googleSub && existing.googleSub !== restricted.sub) {
          await recordEvent("GOOGLE_LINKED", "FAIL", ctx, {
            userId: existing.id,
            phone: challenge.phoneE164,
            meta: { reason: "conflict" },
          });
          throw new AppError(409, "GOOGLE_CONFLICT", "This phone is linked to another Google account");
        }

        if (existing && existing.status !== "DELETED") {
          const user = await repo.updateUser(existing.id, {
            googleSub: existing.googleSub ?? restricted.sub,
            email: existing.email ?? restricted.email ?? null,
            name: existing.name ?? restricted.name ?? null,
            phoneVerifiedAt: existing.phoneVerifiedAt ?? clock(),
          });
          await recordEvent("GOOGLE_LINKED", "OK", ctx, {
            userId: user.id,
            phone: user.phoneE164,
          });

          return completeLogin(user, false, input.consent, input.device, ctx);
        }

        try {
          const user = await repo.createUser({
            phoneE164: challenge.phoneE164,
            phoneVerifiedAt: clock(),
            googleSub: restricted.sub,
            email: restricted.email ?? null,
            name: restricted.name ?? null,
          });
          await recordEvent("GOOGLE_LINKED", "OK", ctx, {
            userId: user.id,
            phone: user.phoneE164,
          });

          return completeLogin(user, true, input.consent, input.device, ctx);
        } catch (error) {
          if (error instanceof UniqueConflictError) {
            throw invalidOtp();
          }

          throw error;
        }
      }

      const { user, isNewUser } = await findOrCreateUser(challenge.phoneE164);

      return completeLogin(user, isNewUser, input.consent, input.device, ctx);
    },

    async googleLogin(
      input: { idToken: string; consent: ConsentInput; device?: DeviceInfo },
      ctx: RequestContext,
    ): Promise<
      | { needsPhone: true; restrictedToken: string; expiresIn: number }
      | ({ needsPhone: false } & IssuedLogin)
      > {
      assertConsent(config, input.consent);
      let identity: GoogleIdentity;

      try {
        identity = await deps.google.verify(input.idToken);
      } catch (error) {
        if (error instanceof Error && error.name === "GoogleVerifierUnavailableError") {
          throw new AppError(503, "AUTH_GOOGLE_UNAVAILABLE", "Google sign-in is unavailable");
        }

        throw new AppError(401, "AUTH_INVALID_GOOGLE_TOKEN", "Invalid Google sign-in");
      }

      const existing = await repo.findUserByGoogleSub(identity.sub);

      if (!existing) {
        const restrictedToken = await tokens.signRestricted(identity);

        return {
          needsPhone: true,
          restrictedToken,
          expiresIn: config.accessTtlSec,
        };
      }

      if (existing.status === "SUSPENDED") {
        throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
      }

      if (existing.status === "DELETED") {
        throw new AppError(401, "AUTH_INVALID_GOOGLE_TOKEN", "Invalid Google sign-in");
      }

      const login = await completeLogin(
        existing,
        false,
        input.consent,
        input.device,
        ctx,
      );

      return { needsPhone: false, ...login };
    },

    async requestGoogleAttachOtp(
      input: { phone: string; captchaToken?: string },
      ctx: RequestContext,
    ): Promise<RequestOtpResult> {
      return requestChallenge(
        {
          phone: input.phone,
          purpose: "GOOGLE_ATTACH",
          captchaToken: input.captchaToken,
        },
        ctx,
      );
    },

    async refresh(
      input: { refreshToken: string },
      ctx: RequestContext,
    ): Promise<RefreshResult> {
      const now = clock();
      const tokenHash = hashToken(input.refreshToken);

      await enforceRateLimit(
        `auth:refresh:${tokenHash}`,
        REFRESH_PER_SESSION_MIN,
        60,
        ctx,
        "REFRESH_FAILED",
      );

      const session = await repo.findSessionByTokenHash(tokenHash);

      if (!session) {
        await recordEvent("REFRESH_FAILED", "FAIL", ctx, { meta: { reason: "unknown" } });
        throw new AppError(401, "AUTH_INVALID_REFRESH", "Invalid refresh token");
      }

      if (session.rotatedAt) {
        const ageMs = now.getTime() - session.rotatedAt.getTime();

        if (ageMs <= REFRESH_RACE_MS) {
          throw new AppError(
            409,
            "AUTH_REFRESH_RACE",
            "This token was just rotated, retry with the new token",
          );
        }

        const ids = await repo.revokeFamily(session.familyId, "refresh_reuse", now);

        for (const id of ids) {
          await revocations.revoke(id, config.accessTtlSec);
        }

        await recordEvent("REFRESH_REUSE", "BLOCKED", ctx, {
          userId: session.userId,
          meta: { familyId: session.familyId },
        });
        emit("REFRESH_REUSE_DETECTED", { userId: session.userId, familyId: session.familyId });
        throw new AppError(
          401,
          "AUTH_REFRESH_REUSE",
          "Refresh token reuse detected, all sessions were revoked",
        );
      }

      if (
        session.revokedAt ||
        session.expiresAt <= now ||
        session.absoluteExpiresAt <= now
      ) {
        throw new AppError(401, "AUTH_INVALID_REFRESH", "Invalid refresh token");
      }

      const user = await repo.findUserById(session.userId);

      if (!user || user.status === "DELETED") {
        throw new AppError(401, "AUTH_INVALID_REFRESH", "Invalid refresh token");
      }

      if (user.status === "SUSPENDED") {
        throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
      }

      const issued = await issueSession(
        user,
        {
          ...(session.deviceName ? { name: session.deviceName } : {}),
          ...(session.platform ? { platform: session.platform } : {}),
        },
        ctx,
        now,
        {
          familyId: session.familyId,
          absoluteExpiresAt: session.absoluteExpiresAt,
        },
      );

      const claimed = await repo.markSessionRotated(session.id, issued.session.id, now);

      if (!claimed) {
        await repo.revokeSession(issued.session.id, "rotation_race", now);
        throw new AppError(409, "AUTH_REFRESH_RACE", "This token was just rotated");
      }

      await recordEvent("TOKEN_REFRESHED", "OK", ctx, {
        userId: user.id,
        meta: { sessionId: issued.session.id },
      });

      return {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresIn: issued.expiresIn,
      };
    },

    async logout(
      userId: string,
      currentSessionId: string,
      ctx: RequestContext,
    ): Promise<void> {
      const now = clock();
      const session = await repo.findSessionById(currentSessionId);
      const ids = new Set<string>([currentSessionId]);

      if (session && session.userId === userId) {
        for (const id of await repo.revokeFamily(session.familyId, "logout", now)) {
          ids.add(id);
        }
      } else {
        await repo.revokeSession(currentSessionId, "logout", now);
      }

      for (const id of ids) {
        await revocations.revoke(id, config.accessTtlSec);
      }

      await recordEvent("SESSION_REVOKED", "OK", ctx, { userId });
    },

    async logoutAll(userId: string, ctx: RequestContext): Promise<void> {
      const now = clock();
      const ids = await repo.revokeAllSessions(userId, "logout_all", now);

      await repo.incrementTokenVersion(userId);

      for (const id of ids) {
        await revocations.revoke(id, config.accessTtlSec);
      }

      await recordEvent("SESSION_REVOKED", "OK", ctx, { userId, meta: { all: true } });
    },

    async listSessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
      const now = clock();
      const currentSession = await repo.findSessionById(currentSessionId);
      const sessions: SessionRecord[] = await repo.listActiveSessions(userId, now);

      return sessions.map((session) => ({
        id: session.id,
        deviceName: session.deviceName,
        platform: session.platform,
        lastUsedAt: session.lastUsedAt,
        ipMasked: maskIp(session.ip),
        current: currentSession?.familyId === session.familyId,
      }));
    },

    async revokeSession(userId: string, sessionId: string, ctx: RequestContext): Promise<void> {
      const now = clock();
      const session = await repo.findSessionById(sessionId);

      if (!session || session.userId !== userId) {
        throw new AppError(404, "AUTH_SESSION_NOT_FOUND", "Session not found");
      }

      const ids = await repo.revokeFamily(session.familyId, "revoked_by_user", now);

      for (const id of ids) {
        await revocations.revoke(id, config.accessTtlSec);
      }

      await recordEvent("SESSION_REVOKED", "OK", ctx, {
        userId,
        meta: { sessionId, familyId: session.familyId },
      });
    },

    async getMe(userId: string): Promise<AuthUser> {
      const user = await repo.findUserById(userId);

      if (!user || user.status === "DELETED") {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
      }

      return toAuthUser(user);
    },

    async updateMe(
      userId: string,
      input: { name?: string; locale?: "NE" | "EN" },
    ): Promise<AuthUser> {
      const user = await repo.updateUser(userId, input);

      return toAuthUser(user);
    },

    async requestPhoneChange(
      userId: string,
      input: { newPhone: string; captchaToken?: string },
      ctx: RequestContext,
    ): Promise<RequestOtpResult> {
      const current = await repo.findUserById(userId);
      const phone = normalizePhone(input.newPhone, config.allowedCountryCodes);

      if (!phone) {
        throw new AppError(400, "AUTH_INVALID_PHONE", "Enter a valid Nepali mobile number");
      }

      if (current?.phoneE164 === phone) {
        throw new AppError(400, "AUTH_SAME_PHONE", "The new number is already your number");
      }

      const target = await repo.findUserByPhone(phone);

      if (target && target.id !== userId) {
        throw new AppError(409, "AUTH_PHONE_IN_USE", "This number is already in use");
      }

      return requestChallenge(
        {
          phone,
          purpose: "PHONE_CHANGE",
          userId,
          captchaToken: input.captchaToken,
        },
        ctx,
      );
    },

    async confirmPhoneChange(
      userId: string,
      currentSessionId: string,
      input: { challengeId: string; code: string },
      ctx: RequestContext,
    ): Promise<void> {
      await enforceVerifyIpLimit(ctx);
      const challenge = await takeChallenge(input.challengeId, "PHONE_CHANGE", input.code, ctx);

      if (challenge.userId !== userId) {
        throw invalidOtp();
      }

      const now = clock();
      const current = await repo.findUserById(userId);
      const target = await repo.findUserByPhone(challenge.phoneE164);

      if (target && target.id !== userId) {
        throw new AppError(409, "AUTH_PHONE_IN_USE", "This number is already in use");
      }

      const currentSession = await repo.findSessionById(currentSessionId);

      let revokedIds: string[];

      try {
        revokedIds = await repo.changePhone(
          userId,
          challenge.phoneE164,
          currentSession?.familyId ?? "",
          "phone_changed",
          now,
        );
      } catch (error) {
        if (error instanceof UniqueConflictError) {
          throw new AppError(409, "AUTH_PHONE_IN_USE", "This number is already in use");
        }

        throw error;
      }

      for (const id of revokedIds) {
        await revocations.revoke(id, config.accessTtlSec);
      }

      await recordEvent("PHONE_CHANGED", "OK", ctx, {
        userId,
        phone: challenge.phoneE164,
        meta: { oldPhoneMasked: current ? maskPhone(current.phoneE164) : null },
      });
      emit("PHONE_CHANGED_NOTICE", {
        userId,
        oldPhoneMasked: current ? maskPhone(current.phoneE164) : null,
        newPhoneMasked: maskPhone(challenge.phoneE164),
      });
    },

    async linkGoogle(
      userId: string,
      input: { idToken: string },
      ctx: RequestContext,
    ): Promise<AuthUser> {
      let identity: GoogleIdentity;

      try {
        identity = await deps.google.verify(input.idToken);
      } catch (error) {
        if (error instanceof Error && error.name === "GoogleVerifierUnavailableError") {
          throw new AppError(503, "AUTH_GOOGLE_UNAVAILABLE", "Google sign-in is unavailable");
        }

        throw new AppError(401, "AUTH_INVALID_GOOGLE_TOKEN", "Invalid Google sign-in");
      }

      const owner = await repo.findUserByGoogleSub(identity.sub);

      if (owner && owner.id !== userId) {
        throw new AppError(409, "GOOGLE_CONFLICT", "This Google account is linked elsewhere");
      }

      const user = await repo.findUserById(userId);

      if (!user) {
        throw new AppError(401, "UNAUTHORIZED", "Authentication required");
      }

      if (user.googleSub && user.googleSub !== identity.sub) {
        throw new AppError(409, "GOOGLE_CONFLICT", "A different Google account is already linked");
      }

      try {
        const updated = await repo.updateUser(userId, {
          googleSub: identity.sub,
          ...(user.email ? {} : { email: identity.email ?? null }),
          ...(user.name ? {} : { name: identity.name ?? null }),
        });
        await recordEvent("GOOGLE_LINKED", "OK", ctx, { userId });
        emit("GOOGLE_LINKED", { userId });

        return toAuthUser(updated);
      } catch (error) {
        if (error instanceof UniqueConflictError) {
          throw new AppError(409, "GOOGLE_CONFLICT", "This Google account is linked elsewhere");
        }

        throw error;
      }
    },

    async unlinkGoogle(userId: string, ctx: RequestContext): Promise<void> {
      await repo.unlinkGoogle(userId);
      await recordEvent("GOOGLE_UNLINKED", "OK", ctx, { userId });
      emit("GOOGLE_UNLINKED", { userId });
    },

    async requestAccountDeletion(userId: string, ctx: RequestContext): Promise<void> {
      const now = clock();
      await repo.setDeletion(userId, now);
      await recordEvent("ACCOUNT_DELETION_REQUESTED", "OK", ctx, { userId });
      emit("ACCOUNT_DELETION_REQUESTED", { userId, requestedAt: now.toISOString() });
    },

    async cancelAccountDeletion(userId: string, ctx: RequestContext): Promise<void> {
      await repo.setDeletion(userId, null);
      await recordEvent("ACCOUNT_DELETION_CANCELLED", "OK", ctx, { userId });
      emit("ACCOUNT_DELETION_CANCELLED", { userId });
    },

    async publicConfig() {
      const now = clock();
      const day = utcDay(now);
      const spend = await limiter.get(`sms:${day}:spend`);
      const forced = (await limiter.get(`sms:${day}:captcha-force`)) > 0;

      return {
        termsVersion: config.termsVersion,
        privacyVersion: config.privacyVersion,
        captchaRequired: forced || spend >= config.smsDailyCap,
        otpLength: OTP_LENGTH,
        otpTtlSec: config.otpTtlSec,
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
