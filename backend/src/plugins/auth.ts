import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { createMemoryRateLimiter, createRedisRateLimiter, type RateLimiter } from "../lib/rate-limit.js";
import { createMemoryRevocationStore, createRedisRevocationStore, type RevocationStore } from "../lib/revocations.js";
import { createTokenService } from "../lib/tokens.js";
import { createAuthRepo } from "../modules/auth/auth.repo.js";
import { createAuthService, type AuthConfig } from "../modules/auth/auth.service.js";
import type { AuthRepo } from "../modules/auth/auth.types.js";
import { createGoogleVerifier, type GoogleVerifier } from "../providers/google.js";
import { createSmsAlert } from "../providers/sms/alerts.js";
import { createSmsProviderFromEnv } from "../providers/sms/index.js";
import { createBullMqSmsSender, createImmediateSmsSender } from "../providers/sms/queue.js";
import type { SmsSender } from "../providers/sms/types.js";
import { createTurnstileVerifier, type CaptchaVerifier } from "../providers/turnstile.js";

type AuthPluginOptions = {
  repo?: AuthRepo;
  limiter?: RateLimiter;
  revocations?: RevocationStore;
  sms?: SmsSender;
  google?: GoogleVerifier;
  captcha?: CaptchaVerifier;
  now?: () => Date;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
};

function readBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  return header.slice("Bearer ".length).trim() || undefined;
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app, options) => {
    const redis = app.hasDecorator("redis") ? app.redis : null;
    const limiter =
      options.limiter ??
      (redis ? createRedisRateLimiter(redis) : createMemoryRateLimiter());
    const revocations =
      options.revocations ??
      (redis ? createRedisRevocationStore(redis) : createMemoryRevocationStore());
    const tokens = createTokenService({
      privateKeyBase64: env.JWT_PRIVATE_KEY,
      publicKeysBase64: JSON.parse(env.JWT_PUBLIC_KEYS) as Record<string, string>,
      kid: env.JWT_KID,
      accessTtlSec: env.JWT_ACCESS_TTL_SEC,
    });
    const google = options.google ?? createGoogleVerifier(env.GOOGLE_OAUTH_CLIENT_ID);
    const captcha = options.captcha ?? createTurnstileVerifier(env.TURNSTILE_SECRET);
    const alert = createSmsAlert(env, app.log);

    let sms: SmsSender;

    if (options.sms) {
      sms = options.sms;
    } else {
      const bundle = createSmsProviderFromEnv(env, app.log);
      sms =
        redis && env.SMS_PROVIDER !== "fake" && env.SMS_PROVIDER !== "console"
          ? createBullMqSmsSender(env.REDIS_URL, bundle.provider, app.log)
          : createImmediateSmsSender(bundle.provider);
    }

    const config: AuthConfig = {
      otpPepper: env.OTP_PEPPER,
      otpTtlSec: env.OTP_TTL_SEC,
      timingFloorMs: env.AUTH_TIMING_FLOOR_MS,
      ...(env.OTP_DEV_BYPASS ? { otpDevBypass: env.OTP_DEV_BYPASS } : {}),
      allowedCountryCodes: env.ALLOWED_COUNTRY_CODES,
      smsDailyCap: env.SMS_DAILY_CAP,
      ...(env.ANDROID_SMS_HASH ? { androidSmsHash: env.ANDROID_SMS_HASH } : {}),
      termsVersion: env.TERMS_VERSION,
      privacyVersion: env.PRIVACY_VERSION,
      accessTtlSec: env.JWT_ACCESS_TTL_SEC,
      refreshSlidingDays: env.REFRESH_SLIDING_DAYS,
      refreshAbsoluteDays: env.REFRESH_ABSOLUTE_DAYS,
      maxActiveSessions: env.MAX_ACTIVE_SESSIONS,
      isProduction: env.NODE_ENV === "production",
    };

    const repo = options.repo ?? createAuthRepo(app.prisma);
    const authService = createAuthService({
      repo,
      limiter,
      revocations,
      tokens,
      sms,
      google,
      captcha,
      config,
      log: app.log,
      alert,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

    async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const token = readBearer(request);

      if (!token) {
        throw AppError.unauthorized();
      }

      let claims;

      try {
        claims = await tokens.verify(token);
      } catch {
        throw AppError.unauthorized();
      }

      if (!claims.scp.includes("app")) {
        throw AppError.unauthorized();
      }

      const user = await repo.findUserById(claims.sub);

      if (
        !user ||
        user.status === "DELETED" ||
        (!claims.imp && claims.tv !== user.tokenVersion)
      ) {
        throw AppError.unauthorized();
      }

      if (user.status === "SUSPENDED") {
        throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
      }

      if (claims.imp) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new AppError(
            403,
            "IMPERSONATION_READ_ONLY",
            "Impersonation tokens are read-only",
          );
        }

        request.impersonation = claims.imp;
      } else {
        const session = await repo.findSessionById(claims.sid);

        if (
          !session ||
          session.userId !== claims.sub ||
          session.revokedAt !== null ||
          session.expiresAt <= new Date()
        ) {
          throw AppError.unauthorized();
        }

        if (await revocations.isRevoked(claims.sid)) {
          throw AppError.unauthorized();
        }
      }

      request.auth = {
        userId: claims.sub,
        sessionId: claims.sid,
        scopes: claims.scp,
      };
      request.user = { sub: claims.sub };
    }

    async function verifyGoogleAttach(request: FastifyRequest) {
      const token = readBearer(request);

      if (!token) {
        throw AppError.unauthorized();
      }

      try {
        const identity = await tokens.verifyRestricted(token);
        request.googleIdentity = identity;

        return identity;
      } catch {
        throw AppError.unauthorized();
      }
    }

    app.decorateRequest("auth", null);
    app.decorateRequest("user", null as unknown as { sub: string });
    app.decorateRequest("googleIdentity", null);
    app.decorateRequest("impersonation", null);
    app.decorate("authService", authService);
    app.decorate("requireAuth", requireAuth);
    app.decorate("authenticate", requireAuth);
    app.decorate("verifyGoogleAttach", verifyGoogleAttach);

    app.addHook("onClose", async () => {
      await sms.close();
    });
  },
  {
    name: "auth",
    dependencies: ["prisma"],
  },
);
