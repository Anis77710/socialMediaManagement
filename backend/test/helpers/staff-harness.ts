import { createAdminPreAuthService } from "../../src/lib/admin-tokens.js";
import { createAuditWriter } from "../../src/lib/audit.js";
import { createSecretBox } from "../../src/lib/encryption.js";
import {
  createMemoryOneTimeTokenStore,
} from "../../src/lib/one-time-tokens.js";
import type { PasswordHasher } from "../../src/lib/password.js";
import { defaultPasswordPolicy } from "../../src/lib/password.js";
import { createMemoryRateLimiter } from "../../src/lib/rate-limit.js";
import { createMemoryJsonCache } from "../../src/lib/session-cache.js";
import { createTotpService } from "../../src/lib/totp.js";
import { createTokenService } from "../../src/lib/tokens.js";
import { FakeEmailProvider } from "../../src/providers/email/fake.js";
import {
  createStaffAuthService,
  hashEmail,
  type StaffAuthConfig,
} from "../../src/modules/staff/staff-auth.service.js";
import { createStaffManagementService } from "../../src/modules/staff/staff-management.service.js";
import type { StaffRole } from "../../src/lib/permissions.js";
import type { StaffStatus } from "../../src/modules/staff/staff.types.js";
import { createFakeAuditRepo } from "./fake-audit-repo.js";
import { createFakeStaffRepo } from "./fake-staff-repo.js";

export const IP = "203.0.113.10";
export const UA = "Mozilla/5.0 test-browser";
export const STRONG_PASSWORD = "Vh7!mq2Lx#9pWt4Q";

const fakeHasher: PasswordHasher = {
  async hash(password) {
    return `fake:${password}`;
  },
  async verify(encoded, password) {
    return encoded === `fake:${password}`;
  },
  needsRehash() {
    return false;
  },
  async dummyVerify() {
    return undefined;
  },
};

export function createStaffHarness(
  overrides: { config?: Partial<StaffAuthConfig> } = {},
) {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(nowMs);
  const advance = (seconds: number) => {
    nowMs += seconds * 1000;
  };
  const fake = createFakeStaffRepo(clock);
  const auditRepo = createFakeAuditRepo();
  const audit = createAuditWriter({ repo: auditRepo.repo, now: clock });
  const email = new FakeEmailProvider();
  const limiter = createMemoryRateLimiter(() => nowMs);
  const oneTimeTokens = createMemoryOneTimeTokenStore(() => nowMs);
  const cache = createMemoryJsonCache(() => nowMs);
  const totp = createTotpService({ issuer: "Redflie Test", now: clock });
  const secretBox = createSecretBox(
    { v1: process.env.TOKEN_ENCRYPTION_KEY! },
    "v1",
  );
  const preAuth = createAdminPreAuthService({
    privateKeyBase64: process.env.JWT_PRIVATE_KEY!,
    publicKeysBase64: JSON.parse(process.env.JWT_PUBLIC_KEYS!) as Record<string, string>,
    kid: process.env.JWT_KID!,
    ttlSec: 300,
  });
  const tokens = createTokenService({
    privateKeyBase64: process.env.JWT_PRIVATE_KEY!,
    publicKeysBase64: JSON.parse(process.env.JWT_PUBLIC_KEYS!) as Record<string, string>,
    kid: process.env.JWT_KID!,
    accessTtlSec: 900,
  });
  const logs: string[] = [];
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const log = {
    info(object: Record<string, unknown>, message: string) {
      logs.push(message);
      void object;
    },
    warn(object: Record<string, unknown>, message: string) {
      logs.push(message);
      void object;
    },
    error(object: Record<string, unknown>, message: string) {
      logs.push(message);
      void object;
    },
  };
  const config: StaffAuthConfig = {
    adminWebUrl: "http://localhost:3001",
    sessionIdleSec: 1800,
    sessionAbsoluteSec: 8 * 3600,
    maxSessions: 3,
    stepUpSec: 300,
    preAuthTtlSec: 300,
    inviteTtlSec: 72 * 3600,
    resetTtlSec: 1800,
    loginIpLimit: 100,
    loginIpWindowSec: 900,
    lockoutAlertThreshold: 10,
    timingFloorMs: 0,
    hibpEnabled: false,
    exposeDevTokens: true,
    passwordPolicy: defaultPasswordPolicy,
    ...overrides.config,
  };
  const revokedBatches: string[][] = [];
  const auth = createStaffAuthService({
    repo: fake.repo,
    audit,
    email,
    limiter,
    oneTimeTokens,
    passwordHasher: fakeHasher,
    totp,
    secretBox,
    preAuth,
    config,
    log,
    now: clock,
    onEvent(type, payload) {
      emitted.push({ type, payload });
    },
    onSessionsRevoked(ids) {
      revokedBatches.push(ids);
    },
  });
  const management = createStaffManagementService({
    repo: fake.repo,
    audit,
    email,
    tokens,
    config: {
      adminWebUrl: config.adminWebUrl,
      inviteTtlSec: config.inviteTtlSec,
      exposeDevTokens: config.exposeDevTokens,
    },
    log,
    now: clock,
    onEvent(type, payload) {
      emitted.push({ type, payload });
    },
    onSessionsRevoked(ids) {
      revokedBatches.push(ids);
    },
  });

  async function seedStaff(
    input: {
      email?: string;
      name?: string;
      role?: StaffRole;
      status?: StaffStatus;
      password?: string;
      mfa?: boolean;
    } = {},
  ) {
    const emailAddress = input.email ?? "admin@example.com";
    const password = input.password ?? STRONG_PASSWORD;
    const status =
      input.status ?? (input.password === undefined && !input.mfa ? "INVITED" : "ACTIVE");
    const created = await fake.repo.createStaff({
      email: emailAddress,
      name: input.name ?? "Test Admin",
      role: input.role ?? "SUPER_ADMIN",
      status,
    });

    if (input.password !== undefined || input.mfa) {
      await fake.repo.updateStaff(created.id, {
        passwordHash: `fake:${password}`,
        passwordChangedAt: clock(),
      });
    }

    let secret: string | undefined;

    if (input.mfa) {
      secret = totp.generateSecret();
      await fake.repo.updateStaff(created.id, {
        totpSecretEnc: secretBox.encrypt(secret),
        mfaEnabledAt: clock(),
      });
    }

    return { staff: (await fake.repo.findStaffById(created.id))!, secret, password };
  }

  async function login(
    email: string,
    password = STRONG_PASSWORD,
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    return auth.login({ email, password }, { ip: ctx.ip ?? IP, userAgent: ctx.userAgent ?? UA });
  }

  async function completeMfa(
    mfaToken: string,
    secret: string,
    ctx: { ip?: string; userAgent?: string } = {},
    at?: Date,
  ) {
    const code = await totp.code(secret, at);

    return auth.verifyMfa(
      { mfaToken, code },
      { ip: ctx.ip ?? IP, userAgent: ctx.userAgent ?? UA },
    );
  }

  async function loginWithMfa(
    email: string,
    secret: string,
    ctx: { ip?: string; userAgent?: string } = {},
  ) {
    const start = await login(email, STRONG_PASSWORD, ctx);

    return completeMfa(start.mfaToken, secret, ctx);
  }

  async function passwordResetToken(emailAddress: string): Promise<string> {
    await auth.forgotPassword({ email: emailAddress }, { ip: IP });
    const message = email.lastTo(emailAddress);
    const match = message?.text.match(/token=([A-Za-z0-9_-]+)/);

    if (!match) {
      throw new Error("No password reset email sent");
    }

    return match[1];
  }

  return {
    repo: fake.repo,
    store: fake,
    auditRepo,
    email,
    limiter,
    oneTimeTokens,
    cache,
    totp,
    secretBox,
    preAuth,
    tokens,
    auth,
    management,
    config,
    logs,
    emitted,
    revokedBatches,
    now: clock,
    advance,
    seedStaff,
    login,
    completeMfa,
    loginWithMfa,
    passwordResetToken,
    hashEmail,
    passwordHasher: fakeHasher,
  };
}

export type StaffHarness = ReturnType<typeof createStaffHarness>;
