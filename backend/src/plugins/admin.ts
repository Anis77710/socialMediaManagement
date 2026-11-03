import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { createAdminPreAuthService, type AdminPreAuthService } from "../lib/admin-tokens.js";
import { createAuditWriter, createPrismaAuditRepo, type AuditRepo } from "../lib/audit.js";
import { hashToken } from "../lib/crypto.js";
import { createSecretBox, type SecretBox } from "../lib/encryption.js";
import { createIpAllowlist } from "../lib/ip.js";
import {
  createMemoryOneTimeTokenStore,
  createRedisOneTimeTokenStore,
  type OneTimeTokenStore,
} from "../lib/one-time-tokens.js";
import {
  createPasswordHasher,
  defaultPasswordPolicy,
  type PasswordHasher,
} from "../lib/password.js";
import { hasPermission, type Permission } from "../lib/permissions.js";
import {
  createMemoryRateLimiter,
  createRedisRateLimiter,
  type RateLimiter,
} from "../lib/rate-limit.js";
import {
  createMemoryJsonCache,
  createRedisJsonCache,
  type JsonCache,
} from "../lib/session-cache.js";
import { createTotpService, type TotpService } from "../lib/totp.js";
import { createTokenService, type TokenService } from "../lib/tokens.js";
import { safeEqualHex } from "../lib/hmac.js";
import { AppError } from "../lib/errors.js";
import { createEmailProviderFromEnv } from "../providers/email/index.js";
import type { EmailProvider } from "../providers/email/types.js";
import { createStaffAuthService } from "../modules/staff/staff-auth.service.js";
import { createStaffManagementService } from "../modules/staff/staff-management.service.js";
import { createStaffRepo } from "../modules/staff/staff.repo.js";
import type {
  RequestContext,
  StaffRepo,
  StaffSessionRecord,
} from "../modules/staff/staff.types.js";

export const ADMIN_COOKIE = "__Host-rf_admin";

export type AdminOverrides = {
  repo?: StaffRepo;
  audit?: AuditRepo;
  email?: EmailProvider;
  limiter?: RateLimiter;
  oneTimeTokens?: OneTimeTokenStore;
  cache?: JsonCache;
  passwordHasher?: PasswordHasher;
  totp?: TotpService;
  secretBox?: SecretBox;
  preAuth?: AdminPreAuthService;
  tokens?: TokenService;
  now?: () => Date;
  hibpCheck?: (password: string) => Promise<boolean>;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
};

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const cookie = request.cookies?.[name];

  return typeof cookie === "string" ? cookie : undefined;
}

function reviveSession(raw: StaffSessionRecord): StaffSessionRecord {
  return {
    ...raw,
    stepUpUntil: raw.stepUpUntil ? new Date(raw.stepUpUntil) : null,
    idleExpiresAt: new Date(raw.idleExpiresAt),
    absoluteExpiresAt: new Date(raw.absoluteExpiresAt),
    lastSeenAt: raw.lastSeenAt ? new Date(raw.lastSeenAt) : null,
    revokedAt: raw.revokedAt ? new Date(raw.revokedAt) : null,
    createdAt: new Date(raw.createdAt),
  };
}

export const adminPlugin = fp<AdminOverrides>(
  async (app, options) => {
    const redis = app.hasDecorator("redis") ? app.redis : null;
    const now = options.now ?? (() => new Date());
    const limiter =
      options.limiter ??
      (redis ? createRedisRateLimiter(redis) : createMemoryRateLimiter());
    const cache =
      options.cache ??
      (redis ? createRedisJsonCache(redis) : createMemoryJsonCache(() => now().getTime()));
    const oneTimeTokens =
      options.oneTimeTokens ??
      (redis ? createRedisOneTimeTokenStore(redis) : createMemoryOneTimeTokenStore());
    const repo = options.repo ?? createStaffRepo(app.prisma);
    const auditRepo = options.audit ?? createPrismaAuditRepo(app.prisma);
    const audit = createAuditWriter({ repo: auditRepo, now });
    const email = options.email ?? createEmailProviderFromEnv(env, app.log);
    const passwordHasher =
      options.passwordHasher ??
      createPasswordHasher({
        memoryCost: env.ARGON2_MEMORY_KIB,
        timeCost: env.ARGON2_TIME_COST,
        parallelism: env.ARGON2_PARALLELISM,
        ...(env.PASSWORD_PEPPER ? { pepper: env.PASSWORD_PEPPER } : {}),
      });
    const totp =
      options.totp ??
      createTotpService({ issuer: env.TOTP_ISSUER, now });
    const secretBox =
      options.secretBox ??
      createSecretBox(
        env.ENCRYPTION_KEYS
          ? (JSON.parse(env.ENCRYPTION_KEYS) as Record<string, string>)
          : { v1: env.TOKEN_ENCRYPTION_KEY },
        env.ENCRYPTION_KEYS ? env.ACTIVE_ENCRYPTION_KID : "v1",
      );
    const preAuth =
      options.preAuth ??
      createAdminPreAuthService({
        privateKeyBase64: env.JWT_PRIVATE_KEY,
        publicKeysBase64: JSON.parse(env.JWT_PUBLIC_KEYS) as Record<string, string>,
        kid: env.JWT_KID,
        ttlSec: env.ADMIN_MFA_TOKEN_TTL_SEC,
      });
    const tokens =
      options.tokens ??
      createTokenService({
        privateKeyBase64: env.JWT_PRIVATE_KEY,
        publicKeysBase64: JSON.parse(env.JWT_PUBLIC_KEYS) as Record<string, string>,
        kid: env.JWT_KID,
        accessTtlSec: env.JWT_ACCESS_TTL_SEC,
      });
    const allowlist = createIpAllowlist(env.ADMIN_IP_ALLOWLIST);
    const cacheTtl = env.ADMIN_SESSION_CACHE_SEC;
    const tombstoneTtl = Math.max(cacheTtl, 60);

    async function invalidateSessions(sessionIds: string[]): Promise<void> {
      if (cacheTtl <= 0) {
        return;
      }

      await Promise.all(
        sessionIds.map((id) =>
          cache.set(`admin:revoked:${id}`, true, tombstoneTtl),
        ),
      );
    }

    const authService = createStaffAuthService({
      repo,
      audit,
      email,
      limiter,
      oneTimeTokens,
      passwordHasher,
      totp,
      secretBox,
      preAuth,
      config: {
        adminWebUrl: env.ADMIN_WEB_URL,
        sessionIdleSec: env.ADMIN_SESSION_IDLE_MIN * 60,
        sessionAbsoluteSec: env.ADMIN_SESSION_ABSOLUTE_HOURS * 3600,
        maxSessions: env.ADMIN_MAX_SESSIONS,
        stepUpSec: env.ADMIN_STEP_UP_MIN * 60,
        preAuthTtlSec: env.ADMIN_MFA_TOKEN_TTL_SEC,
        inviteTtlSec: env.ADMIN_INVITE_TTL_HOURS * 3600,
        resetTtlSec: env.ADMIN_RESET_TTL_MIN * 60,
        loginIpLimit: env.ADMIN_LOGIN_IP_LIMIT,
        loginIpWindowSec: env.ADMIN_LOGIN_IP_WINDOW_MIN * 60,
        lockoutAlertThreshold: env.ADMIN_LOCKOUT_ALERT_THRESHOLD,
        timingFloorMs: env.AUTH_TIMING_FLOOR_MS,
        hibpEnabled: env.HIBP_CHECK_ENABLED,
        exposeDevTokens: env.NODE_ENV !== "production" && env.EMAIL_PROVIDER !== "resend",
        passwordPolicy: defaultPasswordPolicy,
      },
      log: app.log,
      now,
      ...(options.hibpCheck ? { hibpCheck: options.hibpCheck } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      onSessionsRevoked: invalidateSessions,
    });

    const managementService = createStaffManagementService({
      repo,
      audit,
      email,
      tokens,
      config: {
        adminWebUrl: env.ADMIN_WEB_URL,
        inviteTtlSec: env.ADMIN_INVITE_TTL_HOURS * 3600,
        exposeDevTokens: env.NODE_ENV !== "production" && env.EMAIL_PROVIDER !== "resend",
      },
      log: app.log,
      now,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      onSessionsRevoked: invalidateSessions,
    });

    function context(request: FastifyRequest): RequestContext {
      const userAgent = request.headers["user-agent"];

      return {
        ...(request.ip ? { ip: request.ip } : {}),
        ...(typeof userAgent === "string" ? { userAgent } : {}),
        ...(request.id ? { requestId: request.id } : {}),
      };
    }

    async function loadSession(tokenHash: string): Promise<StaffSessionRecord | null> {
      const key = `admin:sess:${tokenHash}`;

      if (cacheTtl > 0) {
        const cached = await cache.get<StaffSessionRecord>(key);

        if (cached) {
          const session = reviveSession(cached);
          const tombstoned = await cache.get<boolean>(`admin:revoked:${session.id}`);

          if (!tombstoned) {
            return session;
          }

          await cache.delete(key);
        }
      }

      const session = await repo.findStaffSessionByTokenHash(tokenHash);

      if (session && cacheTtl > 0) {
        await cache.set(key, session, cacheTtl);
      }

      return session;
    }

    async function requireStaff(
      request: FastifyRequest,
      _reply: FastifyReply,
    ): Promise<void> {
      const token = readCookie(request, ADMIN_COOKIE);

      if (!token) {
        throw AppError.unauthorized();
      }

      const tokenHash = hashToken(token);
      const session = await loadSession(tokenHash);
      const at = now();

      if (
        !session ||
        session.revokedAt !== null ||
        session.idleExpiresAt <= at ||
        session.absoluteExpiresAt <= at
      ) {
        throw AppError.unauthorized();
      }

      const staff = await repo.findStaffById(session.staffId);

      if (!staff || staff.status !== "ACTIVE") {
        await repo.revokeStaffSession(session.id, "inactive", at);
        await invalidateSessions([session.id]);
        throw AppError.unauthorized();
      }

      const userAgent = request.headers["user-agent"] ?? null;

      if (session.userAgent && session.userAgent !== userAgent) {
        await repo.revokeStaffSession(session.id, "user_agent_mismatch", at);
        await invalidateSessions([session.id]);
        await audit.write({
          actorType: "STAFF",
          actorId: staff.id,
          action: "staff.session_user_agent_mismatch",
          entityType: "StaffSession",
          entityId: session.id,
          ip: request.ip ?? null,
          requestId: request.id,
        });
        throw AppError.unauthorized();
      }

      if (session.ip && request.ip && session.ip !== request.ip) {
        await repo.updateStaffSession(session.id, { stepUpUntil: null });
        await cache.delete(`admin:sess:${tokenHash}`);
        await audit.write({
          actorType: "STAFF",
          actorId: staff.id,
          action: "staff.session_ip_changed",
          entityType: "StaffSession",
          entityId: session.id,
          before: { ip: session.ip },
          after: { ip: request.ip },
          ip: request.ip,
          requestId: request.id,
        });
        session.stepUpUntil = null;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        if (request.headers.origin !== env.ADMIN_WEB_URL) {
          throw new AppError(403, "AUTH_ORIGIN_NOT_ALLOWED", "Origin is not allowed");
        }

        const csrf = request.headers["x-csrf-token"];

        if (
          typeof csrf !== "string" ||
          !safeEqualHex(hashToken(csrf), session.csrfHash)
        ) {
          throw new AppError(403, "CSRF_INVALID", "Invalid CSRF token");
        }
      }

      const lastSeen = session.lastSeenAt?.getTime() ?? 0;

      if (cacheTtl <= 0 || at.getTime() - lastSeen > cacheTtl * 1000) {
        await repo.updateStaffSession(session.id, {
          lastSeenAt: at,
          idleExpiresAt: new Date(at.getTime() + env.ADMIN_SESSION_IDLE_MIN * 60_000),
        });
        await cache.delete(`admin:sess:${tokenHash}`);
      }

      request.staff = staff;
      request.staffSession = session;
    }

    async function requireStepUp(
      request: FastifyRequest,
      _reply: FastifyReply,
    ): Promise<void> {
      const current = request.staffSession;

      if (!current) {
        throw new AppError(403, "STEP_UP_REQUIRED", "Additional verification is required");
      }

      const session = await repo.findStaffSessionById(current.id);

      if (
        !session ||
        session.revokedAt ||
        !session.stepUpUntil ||
        session.stepUpUntil <= now()
      ) {
        throw new AppError(403, "STEP_UP_REQUIRED", "Additional verification is required");
      }

      request.staffSession = session;
    }

    function requirePermission(permission: Permission) {
      return async function permissionGuard(
        request: FastifyRequest,
        _reply: FastifyReply,
      ): Promise<void> {
        const staff = request.staff;

        if (!staff) {
          throw AppError.unauthorized();
        }

        if (!hasPermission(staff.role, permission)) {
          throw AppError.forbidden();
        }
      };
    }

    app.decorateRequest("staff", null);
    app.decorateRequest("staffSession", null);
    app.decorate("staffAuthService", authService);
    app.decorate("staffManagementService", managementService);
    app.decorate("requireStaff", requireStaff);
    app.decorate("requireStepUp", requireStepUp);
    app.decorate("requirePermission", requirePermission);
    app.decorate("adminIpAllowed", (ip: string | undefined) => allowlist(ip ?? ""));
    app.decorate("adminContext", context);
    app.decorate("invalidateAdminSessions", invalidateSessions);
  },
  {
    name: "admin",
    dependencies: ["prisma"],
  },
);
