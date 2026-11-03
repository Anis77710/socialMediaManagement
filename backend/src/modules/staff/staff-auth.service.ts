import { randomBytes, randomInt } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import type { AdminPreAuthService } from "../../lib/admin-tokens.js";
import type { AuditActorType, AuditWriter } from "../../lib/audit.js";
import { hashToken } from "../../lib/crypto.js";
import { maskIp } from "../../lib/phone.js";
import { permissionsFor, type StaffRole } from "../../lib/permissions.js";
import type { OneTimeTokenStore } from "../../lib/one-time-tokens.js";
import {
  defaultPasswordPolicy,
  evaluatePasswordPolicy,
  isPasswordPwned,
  type PasswordHasher,
  type PasswordPolicyConfig,
} from "../../lib/password.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import type { SecretBox } from "../../lib/encryption.js";
import type { TotpService } from "../../lib/totp.js";
import type { EmailProvider } from "../../providers/email/types.js";
import {
  lockedOutEmail,
  newLoginEmail,
  passwordChangedEmail,
  passwordResetEmail,
  securityAlertEmail,
} from "./staff.emails.js";
import type {
  RequestContext,
  StaffRecord,
  StaffRepo,
  StaffSessionRecord,
  StaffView,
} from "./staff.types.js";

export type StaffAuthConfig = {
  adminWebUrl: string;
  sessionIdleSec: number;
  sessionAbsoluteSec: number;
  maxSessions: number;
  stepUpSec: number;
  preAuthTtlSec: number;
  inviteTtlSec: number;
  resetTtlSec: number;
  loginIpLimit: number;
  loginIpWindowSec: number;
  lockoutAlertThreshold: number;
  timingFloorMs: number;
  hibpEnabled: boolean;
  exposeDevTokens: boolean;
  passwordPolicy: PasswordPolicyConfig;
};

type Logger = {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

export type StaffAuthService = ReturnType<typeof createStaffAuthService>;

export type StaffSessionResult = {
  sessionToken: string;
  csrfToken: string;
  expiresIn: number;
  staff: StaffView;
};

const lockoutBaseSec = 15 * 60;
const lockoutMaxSec = 24 * 60 * 60;
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashEmail(email: string): string {
  return hashToken(normalizeEmail(email));
}

function lockoutSec(failures: number): number {
  const exponent = Math.min(Math.max(failures - 5, 0), 10);

  return Math.min(lockoutBaseSec * 2 ** exponent, lockoutMaxSec);
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: 10 }, () => {
    const chars = Array.from(
      { length: 10 },
      () => recoveryAlphabet[randomInt(0, recoveryAlphabet.length)],
    );

    return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
  });

  return {
    plain,
    hashes: plain.map((code) => hashToken(normalizeRecoveryCode(code))),
  };
}

function staffView(staff: StaffRecord): StaffView {
  return {
    id: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    status: staff.status,
    mfaEnabled: staff.mfaEnabledAt !== null,
    permissions: [...permissionsFor(staff.role)],
    lastLoginAt: staff.lastLoginAt,
  };
}

export function createStaffAuthService(options: {
  repo: StaffRepo;
  audit: AuditWriter;
  email: EmailProvider;
  limiter: RateLimiter;
  oneTimeTokens: OneTimeTokenStore;
  passwordHasher: PasswordHasher;
  totp: TotpService;
  secretBox: SecretBox;
  preAuth: AdminPreAuthService;
  config: StaffAuthConfig;
  log: Logger;
  now?: () => Date;
  hibpCheck?: (password: string) => Promise<boolean>;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onSessionsRevoked?: (sessionIds: string[]) => Promise<void> | void;
}) {
  const { repo, audit, email, limiter, oneTimeTokens, passwordHasher, totp, secretBox } =
    options;
  const { config, log } = options;
  const now = options.now ?? (() => new Date());
  const hibpCheck =
    options.hibpCheck ?? ((password: string) => isPasswordPwned(password, { log }));

  async function sendEmail(message: Parameters<EmailProvider["send"]>[0]): Promise<void> {
    try {
      await email.send(message);
    } catch (error) {
      log.warn({ error, to: message.to }, "staff_email_send_failed");
    }
  }

  async function alertSuperAdmins(message: string, actorEmail?: string): Promise<void> {
    const admins = await repo.listSuperAdmins();

    await Promise.all(
      admins
        .filter((admin) => admin.email !== actorEmail)
        .map((admin) =>
          sendEmail(
            securityAlertEmail({
              email: admin.email,
              message,
              ...(actorEmail ? { actorEmail } : {}),
            }),
          ),
        ),
    );
  }

  function auditEntry(input: {
    actorType: AuditActorType;
    actorId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
    ctx: RequestContext;
  }) {
    return audit.write({
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason ?? null,
      ip: input.ctx.ip ?? null,
      requestId: input.ctx.requestId ?? null,
    });
  }

  async function padResponse(startedAt: number): Promise<void> {
    const remaining = config.timingFloorMs - (Date.now() - startedAt);

    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  async function notifyRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0 || !options.onSessionsRevoked) {
      return;
    }

    try {
      await options.onSessionsRevoked(sessionIds);
    } catch (error) {
      log.warn({ error, sessionIds }, "admin_session_cache_invalidation_failed");
    }
  }

  async function loadActiveStaff(staffId: string): Promise<StaffRecord> {
    const staff = await repo.findStaffById(staffId);

    if (!staff) {
      throw AppError.unauthorized();
    }

    if (staff.status === "DISABLED") {
      throw new AppError(403, "STAFF_DISABLED", "This staff account is disabled");
    }

    return staff;
  }

  async function assertStrongPassword(
    password: string,
    emailAddress: string,
    name: string,
  ): Promise<void> {
    const result = evaluatePasswordPolicy(
      password,
      [emailAddress, name],
      config.passwordPolicy ?? defaultPasswordPolicy,
    );

    if (!result.ok) {
      throw new AppError(400, "WEAK_PASSWORD", "Password is not strong enough", {
        reasons: result.reasons,
      });
    }

    if (config.hibpEnabled && (await hibpCheck(password))) {
      throw new AppError(
        400,
        "PASSWORD_BREACHED",
        "This password has appeared in a data breach",
      );
    }
  }

  async function registerFailure(
    staff: StaffRecord,
    reason: string,
    ctx: RequestContext,
  ): Promise<void> {
    const at = now();
    const failures = await repo.incrementFailedLogins(staff.id);

    await repo.recordLoginAttempt({
      emailHash: hashEmail(staff.email),
      ip: ctx.ip ?? "unknown",
      success: false,
      reason,
      at,
    });

    if (failures >= 5) {
      const seconds = lockoutSec(failures);
      await repo.updateStaff(staff.id, {
        lockedUntil: new Date(at.getTime() + seconds * 1000),
      });

      await sendEmail(
        lockedOutEmail({
          email: staff.email,
          minutes: Math.round(seconds / 60),
          ip: ctx.ip ?? "unknown",
        }),
      );

      if (failures >= config.lockoutAlertThreshold) {
        await alertSuperAdmins(
          `Staff account ${staff.email} was locked out after ${failures} failed attempts.`,
          staff.email,
        );
      }

      await auditEntry({
        actorType: "SYSTEM",
        action: "staff.locked_out",
        entityType: "StaffUser",
        entityId: staff.id,
        after: { failures, seconds },
        ctx,
      });
    }
  }

  async function markSuccessfulLogin(
    staff: StaffRecord,
    ctx: RequestContext,
  ): Promise<StaffRecord> {
    const at = now();
    const updated = await repo.updateStaff(staff.id, {
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: at,
      lastLoginIp: ctx.ip ?? null,
    });

    if (staff.lastLoginIp && ctx.ip && staff.lastLoginIp !== ctx.ip) {
      await sendEmail(
        newLoginEmail({
          email: staff.email,
          ip: ctx.ip,
          at,
        }),
      );
    }

    return updated;
  }

  async function createSession(
    staff: StaffRecord,
    ctx: RequestContext,
  ): Promise<StaffSessionResult> {
    const at = now();
    let active = await repo.countActiveStaffSessions(staff.id, at);
    const evicted: string[] = [];

    while (active >= config.maxSessions) {
      const oldest = await repo.oldestActiveStaffSession(staff.id, at);

      if (!oldest) {
        break;
      }

      await repo.revokeStaffSession(oldest.id, "max_sessions", at);
      evicted.push(oldest.id);
      active -= 1;
    }

    if (evicted.length > 0) {
      await notifyRevoked(evicted);
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");

    await repo.createStaffSession({
      staffId: staff.id,
      tokenHash: hashToken(sessionToken),
      csrfHash: hashToken(csrfToken),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      idleExpiresAt: new Date(at.getTime() + config.sessionIdleSec * 1000),
      absoluteExpiresAt: new Date(at.getTime() + config.sessionAbsoluteSec * 1000),
    });

    await auditEntry({
      actorType: "STAFF",
      actorId: staff.id,
      action: "staff.session_created",
      entityType: "StaffUser",
      entityId: staff.id,
      after: { ip: ctx.ip ?? null },
      ctx,
    });

    options.onEvent?.("ADMIN_SESSION_CREATED", {
      staffId: staff.id,
      email: staff.email,
      ip: ctx.ip ?? null,
    });

    return {
      sessionToken,
      csrfToken,
      expiresIn: config.sessionAbsoluteSec,
      staff: staffView(staff),
    };
  }

  async function verifyTotpForStaff(
    staff: StaffRecord,
    code: string,
    allowReplay: boolean,
  ): Promise<{ valid: boolean; step?: bigint }> {
    if (!staff.totpSecretEnc) {
      return { valid: false };
    }

    try {
      const secret = secretBox.decrypt(staff.totpSecretEnc);
      const result = await totp.verify({
        secret,
        token: code.trim(),
        lastStep: allowReplay ? null : staff.totpLastStep,
        at: now(),
      });

      return result.valid ? { valid: true, step: result.step } : { valid: false };
    } catch (error) {
      log.error({ error, staffId: staff.id }, "admin_totp_decrypt_failed");

      return { valid: false };
    }
  }

  async function consumeRecoveryCode(
    staff: StaffRecord,
    code: string,
  ): Promise<boolean> {
    const candidate = hashToken(normalizeRecoveryCode(code));
    const index = staff.recoveryCodeHashes.indexOf(candidate);

    if (index === -1) {
      return false;
    }

    const remaining = staff.recoveryCodeHashes.filter((_, position) => position !== index);
    await repo.updateStaff(staff.id, { recoveryCodeHashes: remaining });

    return true;
  }

  return {
    async login(
      input: { email: string; password: string },
      ctx: RequestContext,
    ): Promise<{
      requiresMfa: true;
      mfaToken: string;
      expiresIn: number;
      enrollmentRequired: boolean;
    }> {
      const startedAt = Date.now();
      const ip = ctx.ip ?? "unknown";
      const limit = await limiter.hit(
        `admin:login:ip:${ip}`,
        config.loginIpLimit,
        config.loginIpWindowSec,
      );

      if (!limit.allowed) {
        throw new AppError(
          429,
          "AUTH_TOO_MANY_ATTEMPTS",
          "Too many sign-in attempts; try again later",
          { retryAfterSec: limit.retryAfterSec },
        );
      }

      const emailAddress = normalizeEmail(input.email);
      const staff = await repo.findStaffByEmail(emailAddress);

      if (!staff || staff.status === "DISABLED" || !staff.passwordHash) {
        await passwordHasher.dummyVerify(input.password);
        await repo.recordLoginAttempt({
          emailHash: hashEmail(emailAddress),
          ip,
          success: false,
          reason: staff ? "unusable_account" : "unknown_email",
          at: now(),
        });
        await padResponse(startedAt);
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid email or password");
      }

      const at = now();

      if (staff.lockedUntil && staff.lockedUntil > at) {
        await passwordHasher.dummyVerify(input.password);
        await repo.recordLoginAttempt({
          emailHash: hashEmail(emailAddress),
          ip,
          success: false,
          reason: "locked",
          at,
        });
        await padResponse(startedAt);
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid email or password");
      }

      const valid = await passwordHasher.verify(staff.passwordHash, input.password);

      if (!valid) {
        await registerFailure(staff, "invalid_password", ctx);
        await padResponse(startedAt);
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid email or password");
      }

      if (passwordHasher.needsRehash(staff.passwordHash)) {
        const passwordHash = await passwordHasher.hash(input.password);
        await repo.updateStaff(staff.id, { passwordHash });
      }

      const enrollmentRequired = staff.mfaEnabledAt === null;
      const mfaToken = await options.preAuth.sign({
        staffId: staff.id,
        purpose: enrollmentRequired ? "enroll" : "mfa",
      });

      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.login_password_verified",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });

      return {
        requiresMfa: true,
        mfaToken,
        expiresIn: config.preAuthTtlSec,
        enrollmentRequired,
      };
    },

    async verifyMfa(
      input: { mfaToken: string; code?: string; recoveryCode?: string },
      ctx: RequestContext,
    ): Promise<StaffSessionResult> {
      const startedAt = Date.now();
      const ip = ctx.ip ?? "unknown";
      const limit = await limiter.hit(`admin:mfa:ip:${ip}`, 20, 15 * 60);

      if (!limit.allowed) {
        throw new AppError(429, "AUTH_TOO_MANY_ATTEMPTS", "Too many attempts; try again later");
      }

      let claims;

      try {
        claims = await options.preAuth.verify(input.mfaToken);
      } catch {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      if (claims.purpose !== "mfa") {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      const staff = await loadActiveStaff(claims.staffId);

      if (!staff.mfaEnabledAt || !staff.totpSecretEnc) {
        throw new AppError(409, "MFA_NOT_ENROLLED", "Multi-factor authentication is not set up");
      }

      let valid = false;
      let usedCode = false;

      if (input.code) {
        const result = await verifyTotpForStaff(staff, input.code, false);

        if (result.valid && result.step !== undefined) {
          await repo.updateStaff(staff.id, { totpLastStep: result.step });
          valid = true;
        }
      } else if (input.recoveryCode) {
        valid = await consumeRecoveryCode(staff, input.recoveryCode);
        usedCode = valid;
      }

      if (!valid) {
        await registerFailure(staff, "invalid_mfa", ctx);
        await padResponse(startedAt);
        throw new AppError(401, "AUTH_INVALID_CODE", "Invalid verification code");
      }

      const jtiOk = await oneTimeTokens.consume(claims.jti, config.preAuthTtlSec);

      if (!jtiOk) {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      const updated = await markSuccessfulLogin(staff, ctx);
      const session = await createSession(updated, ctx);

      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.login_succeeded",
        entityType: "StaffUser",
        entityId: staff.id,
        after: { recoveryCode: usedCode },
        ctx,
      });

      return session;
    },

    async startEnrollment(
      input: { mfaToken: string },
      ctx: RequestContext,
    ): Promise<{ secret: string; otpauthUri: string; expiresIn: number }> {
      let claims;

      try {
        claims = await options.preAuth.verify(input.mfaToken);
      } catch {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      if (claims.purpose !== "enroll") {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      const staff = await loadActiveStaff(claims.staffId);

      if (staff.mfaEnabledAt) {
        throw new AppError(409, "MFA_ALREADY_ENABLED", "Multi-factor authentication is enabled");
      }

      const secret = totp.generateSecret();
      await repo.updateStaff(staff.id, {
        totpSecretEnc: secretBox.encrypt(secret),
        totpLastStep: null,
      });

      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.mfa_enrollment_started",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });

      return {
        secret,
        otpauthUri: totp.uri(staff.email, secret),
        expiresIn: config.preAuthTtlSec,
      };
    },

    async confirmEnrollment(
      input: { mfaToken: string; code: string },
      ctx: RequestContext,
    ): Promise<StaffSessionResult & { recoveryCodes: string[] }> {
      const startedAt = Date.now();
      let claims;

      try {
        claims = await options.preAuth.verify(input.mfaToken);
      } catch {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      if (claims.purpose !== "enroll") {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      const staff = await loadActiveStaff(claims.staffId);

      if (staff.mfaEnabledAt) {
        throw new AppError(409, "MFA_ALREADY_ENABLED", "Multi-factor authentication is enabled");
      }

        const result = await verifyTotpForStaff(staff, input.code, true);

      if (!result.valid || result.step === undefined) {
        await registerFailure(staff, "invalid_enrollment_code", ctx);
        await padResponse(startedAt);
        throw new AppError(401, "AUTH_INVALID_CODE", "Invalid verification code");
      }

      const jtiOk = await oneTimeTokens.consume(claims.jti, config.preAuthTtlSec);

      if (!jtiOk) {
        throw new AppError(401, "AUTH_INVALID_MFA_TOKEN", "Invalid or expired sign-in token");
      }

      const recovery = generateRecoveryCodes();
      const at = now();
      const updated = await repo.updateStaff(staff.id, {
        totpLastStep: result.step,
        mfaEnabledAt: at,
        recoveryCodeHashes: recovery.hashes,
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: at,
        lastLoginIp: ctx.ip ?? null,
      });

      const session = await createSession(updated, ctx);

      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.mfa_enrolled",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });

      return { ...session, recoveryCodes: recovery.plain };
    },

    async stepUp(
      input: { staffId: string; sessionId: string; password: string; code?: string; recoveryCode?: string },
      ctx: RequestContext,
    ): Promise<{ stepUpUntil: Date; expiresIn: number }> {
      const ip = ctx.ip ?? "unknown";
      const limit = await limiter.hit(`admin:stepup:${input.staffId}:${ip}`, 10, 15 * 60);

      if (!limit.allowed) {
        throw new AppError(429, "AUTH_TOO_MANY_ATTEMPTS", "Too many attempts; try again later");
      }

      const staff = await loadActiveStaff(input.staffId);

      if (!staff.passwordHash) {
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid credentials");
      }

      const passwordValid = await passwordHasher.verify(staff.passwordHash, input.password);

      if (!passwordValid) {
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid credentials");
      }

      let valid = false;

      if (input.code) {
      const result = await verifyTotpForStaff(staff, input.code, true);
        valid = result.valid;
      } else if (input.recoveryCode) {
        valid = await consumeRecoveryCode(staff, input.recoveryCode);
      }

      if (!valid) {
        throw new AppError(401, "AUTH_INVALID_CODE", "Invalid verification code");
      }

      const session = await repo.findStaffSessionById(input.sessionId);

      if (!session || session.staffId !== staff.id || session.revokedAt) {
        throw AppError.unauthorized();
      }

      const stepUpUntil = new Date(now().getTime() + config.stepUpSec * 1000);
      await repo.updateStaffSession(session.id, { stepUpUntil });

      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.step_up",
        entityType: "StaffUser",
        entityId: staff.id,
        after: { stepUpUntil },
        ctx,
      });

      return { stepUpUntil, expiresIn: config.stepUpSec };
    },

    async logout(staffId: string, sessionId: string, ctx: RequestContext): Promise<void> {
      await repo.revokeStaffSession(sessionId, "logout", now());
      await notifyRevoked([sessionId]);
      await auditEntry({
        actorType: "STAFF",
        actorId: staffId,
        action: "staff.logout",
        entityType: "StaffSession",
        entityId: sessionId,
        ctx,
      });
    },

    async logoutAll(staffId: string, ctx: RequestContext): Promise<void> {
      const sessionIds = await repo.revokeAllStaffSessions(staffId, "logout_all", now());
      await notifyRevoked(sessionIds);

      await auditEntry({
        actorType: "STAFF",
        actorId: staffId,
        action: "staff.logout_all",
        entityType: "StaffUser",
        entityId: staffId,
        after: { revoked: sessionIds.length },
        ctx,
      });
    },

    async listSessions(
      staffId: string,
      currentSessionId: string,
    ): Promise<
      Array<{
        id: string;
        ipMasked: string | null;
        userAgent: string | null;
        createdAt: Date;
        lastSeenAt: Date | null;
        expiresAt: Date;
        stepUpActive: boolean;
        current: boolean;
      }>
    > {
      const at = now();
      const sessions = await repo.listActiveStaffSessions(staffId, at);

      return sessions.map((session: StaffSessionRecord) => ({
        id: session.id,
        ipMasked: maskIp(session.ip),
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.absoluteExpiresAt,
        stepUpActive: session.stepUpUntil !== null && session.stepUpUntil > at,
        current: session.id === currentSessionId,
      }));
    },

    async revokeSession(
      staffId: string,
      sessionId: string,
      ctx: RequestContext,
    ): Promise<void> {
      const session = await repo.findStaffSessionById(sessionId);

      if (!session || session.staffId !== staffId) {
        throw AppError.notFound("Session not found");
      }

      await repo.revokeStaffSession(sessionId, "revoked_by_staff", now());
      await notifyRevoked([sessionId]);

      await auditEntry({
        actorType: "STAFF",
        actorId: staffId,
        action: "staff.session_revoked",
        entityType: "StaffSession",
        entityId: sessionId,
        ctx,
      });
    },

    async me(staffId: string): Promise<StaffView> {
      return staffView(await loadActiveStaff(staffId));
    },

    async changePassword(
      input: {
        staffId: string;
        sessionId: string;
        currentPassword: string;
        newPassword: string;
      },
      ctx: RequestContext,
    ): Promise<void> {
      const staff = await loadActiveStaff(input.staffId);

      if (!staff.passwordHash) {
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid credentials");
      }

      const currentValid = await passwordHasher.verify(
        staff.passwordHash,
        input.currentPassword,
      );

      if (!currentValid) {
        throw new AppError(401, "AUTH_INVALID_CREDENTIALS", "Invalid credentials");
      }

      if (await passwordHasher.verify(staff.passwordHash, input.newPassword)) {
        throw new AppError(400, "PASSWORD_REUSED", "Choose a different password");
      }

      await assertStrongPassword(input.newPassword, staff.email, staff.name);

      const passwordHash = await passwordHasher.hash(input.newPassword);
      await repo.updateStaff(staff.id, {
        passwordHash,
        passwordChangedAt: now(),
      });
      const revoked = await repo.revokeAllStaffSessions(
        staff.id,
        "password_changed",
        now(),
        input.sessionId,
      );
      await notifyRevoked(revoked);

      await sendEmail(passwordChangedEmail(staff.email));
      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.password_changed",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });
    },

    async regenerateRecoveryCodes(
      staffId: string,
      ctx: RequestContext,
    ): Promise<{ recoveryCodes: string[]; remaining: number }> {
      const staff = await loadActiveStaff(staffId);

      if (!staff.mfaEnabledAt) {
        throw new AppError(409, "MFA_NOT_ENROLLED", "Multi-factor authentication is not set up");
      }

      const recovery = generateRecoveryCodes();
      await repo.updateStaff(staff.id, { recoveryCodeHashes: recovery.hashes });

      await auditEntry({
        actorType: "STAFF",
        actorId: staff.id,
        action: "staff.recovery_codes_regenerated",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });

      return { recoveryCodes: recovery.plain, remaining: recovery.plain.length };
    },

    async forgotPassword(input: { email: string }, ctx: RequestContext): Promise<void> {
      const startedAt = Date.now();
      const ip = ctx.ip ?? "unknown";
      const emailAddress = normalizeEmail(input.email);
      const ipLimit = await limiter.hit(`admin:forgot:ip:${ip}`, 5, 15 * 60);
      const emailLimit = await limiter.hit(`admin:forgot:email:${hashEmail(emailAddress)}`, 3, 60 * 60);

      if (!ipLimit.allowed || !emailLimit.allowed) {
        await padResponse(startedAt);

        return;
      }

      const staff = await repo.findStaffByEmail(emailAddress);

      if (!staff || staff.status !== "ACTIVE") {
        await passwordHasher.dummyVerify("forgot-password-dummy-value");
        await padResponse(startedAt);

        return;
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now().getTime() + config.resetTtlSec * 1000);
      await repo.createPasswordReset({
        staffId: staff.id,
        tokenHash: hashToken(token),
        expiresAt,
      });

      const url = new URL("/reset-password", config.adminWebUrl);
      url.searchParams.set("token", token);

      await sendEmail(
        passwordResetEmail({
          email: staff.email,
          resetUrl: url.toString(),
          expiresAt,
        }),
      );

      await auditEntry({
        actorType: "SYSTEM",
        action: "staff.password_reset_requested",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });

      await padResponse(startedAt);
    },

    async resetPassword(
      input: { token: string; newPassword: string },
      ctx: RequestContext,
    ): Promise<void> {
      const limit = await limiter.hit(`admin:reset:ip:${ctx.ip ?? "unknown"}`, 20, 15 * 60);

      if (!limit.allowed) {
        throw new AppError(429, "AUTH_TOO_MANY_ATTEMPTS", "Too many attempts; try again later");
      }

      const reset = await repo.findPasswordResetByTokenHash(hashToken(input.token));
      const at = now();

      if (!reset || reset.usedAt || reset.expiresAt <= at) {
        throw new AppError(400, "AUTH_INVALID_RESET_TOKEN", "Invalid or expired reset token");
      }

      const staff = await repo.findStaffById(reset.staffId);

      if (!staff || staff.status !== "ACTIVE") {
        throw new AppError(400, "AUTH_INVALID_RESET_TOKEN", "Invalid or expired reset token");
      }

      await assertStrongPassword(input.newPassword, staff.email, staff.name);

      if (staff.passwordHash && (await passwordHasher.verify(staff.passwordHash, input.newPassword))) {
        throw new AppError(400, "PASSWORD_REUSED", "Choose a different password");
      }

      const used = await repo.usePasswordReset(reset.id, at);

      if (!used) {
        throw new AppError(400, "AUTH_INVALID_RESET_TOKEN", "Invalid or expired reset token");
      }

      const passwordHash = await passwordHasher.hash(input.newPassword);
      await repo.updateStaff(staff.id, {
        passwordHash,
        passwordChangedAt: at,
        failedLogins: 0,
        lockedUntil: null,
      });
      const revoked = await repo.revokeAllStaffSessions(staff.id, "password_reset", at);
      await notifyRevoked(revoked);

      await sendEmail(passwordChangedEmail(staff.email));
      await auditEntry({
        actorType: "SYSTEM",
        action: "staff.password_reset_completed",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });
    },

    async inviteInfo(
      token: string,
    ): Promise<{ email: string; role: StaffRole; expiresAt: Date }> {
      const invite = await repo.findInviteByTokenHash(hashToken(token));

      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now()) {
        throw new AppError(404, "INVITE_INVALID", "This invitation is invalid or has expired");
      }

      return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
    },

    async acceptInvite(
      input: { token: string; password: string; name?: string },
      ctx: RequestContext,
    ): Promise<{ email: string; enrollmentRequired: true }> {
      const limit = await limiter.hit(
        `admin:invite:ip:${ctx.ip ?? "unknown"}`,
        20,
        15 * 60,
      );

      if (!limit.allowed) {
        throw new AppError(429, "AUTH_TOO_MANY_ATTEMPTS", "Too many attempts; try again later");
      }

      const invite = await repo.findInviteByTokenHash(hashToken(input.token));

      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now()) {
        throw new AppError(404, "INVITE_INVALID", "This invitation is invalid or has expired");
      }

      const staff = await repo.findStaffByEmail(invite.email);

      if (!staff) {
        throw new AppError(404, "INVITE_INVALID", "This invitation is invalid or has expired");
      }

      if (staff.status !== "INVITED") {
        throw new AppError(409, "INVITE_ALREADY_USED", "This invitation has already been used");
      }

      await assertStrongPassword(input.password, staff.email, input.name ?? staff.name);

      const accepted = await repo.acceptInvite(invite.id, now());

      if (!accepted) {
        throw new AppError(409, "INVITE_ALREADY_USED", "This invitation has already been used");
      }

      const passwordHash = await passwordHasher.hash(input.password);
      await repo.updateStaff(staff.id, {
        name: input.name?.trim() || staff.name,
        passwordHash,
        passwordChangedAt: now(),
        status: "ACTIVE",
      });
      await repo.revokePendingInvites(staff.email, now());

      await auditEntry({
        actorType: "SYSTEM",
        action: "staff.invite_accepted",
        entityType: "StaffUser",
        entityId: staff.id,
        ctx,
      });

      return { email: staff.email, enrollmentRequired: true };
    },
  };
}
