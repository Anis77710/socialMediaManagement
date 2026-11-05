import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { createAuditWriter, createPrismaAuditRepo } from "../lib/audit.js";
import { hashToken } from "../lib/crypto.js";
import { createStaffRepo } from "../modules/staff/staff.repo.js";
import { normalizeEmail } from "../modules/staff/staff-auth.service.js";
import { inviteEmail, securityAlertEmail } from "../modules/staff/staff.emails.js";
import { createEmailProviderFromEnv } from "../providers/email/index.js";

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);

  return index === -1 ? undefined : args[index + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const logger = {
  info() {
    return undefined;
  },
  warn(object: Record<string, unknown>, message: string) {
    console.error(message, object);
  },
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const repo = createStaffRepo(prisma);
const audit = createAuditWriter({ repo: createPrismaAuditRepo(prisma) });
const email = createEmailProviderFromEnv(env, logger);

async function createSuperAdmin(): Promise<void> {
  const emailArg = flag("email") ?? args[1];

  if (!emailArg || !isEmail(emailArg)) {
    fail(
      "Usage: npm run cli -- staff:create-superadmin <email> [name] [--force]",
    );
  }

  const emailAddress = normalizeEmail(emailArg);
  const name = flag("name") ?? args[2];
  const force = args.includes("--force");
  const existingAdmins = await repo.listStaff({
    page: 1,
    limit: 1,
    role: "SUPER_ADMIN",
  });

  if (existingAdmins.total > 0 && !force) {
    fail(
      "A super admin already exists. Re-run with --force and CONFIRM_FORCE=yes to override.",
    );
  }

  if (existingAdmins.total > 0 && process.env.CONFIRM_FORCE !== "yes") {
    fail("Set CONFIRM_FORCE=yes to confirm forced super admin creation.");
  }

  const existing = await repo.findStaffByEmail(emailAddress);
  let staff;

  if (existing && existing.status !== "INVITED") {
    fail(`Staff member ${emailAddress} already exists with status ${existing.status}.`);
  }

  if (existing) {
    staff = await repo.updateStaff(existing.id, {
      role: "SUPER_ADMIN",
      ...(name ? { name } : {}),
    });
    await repo.revokePendingInvites(emailAddress, new Date());
  } else {
    staff = await repo.createStaff({
      email: emailAddress,
      name: name ?? emailAddress.split("@")[0] ?? emailAddress,
      role: "SUPER_ADMIN",
      status: "INVITED",
      createdById: "SYSTEM",
    });
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.ADMIN_INVITE_TTL_HOURS * 3_600_000);
  await repo.createInvite({
    email: emailAddress,
    role: "SUPER_ADMIN",
    tokenHash: hashToken(token),
    invitedById: "SYSTEM",
    expiresAt,
  });

  const url = new URL("/accept-invite", env.ADMIN_WEB_URL);
  url.searchParams.set("token", token);

  await email.send(
    inviteEmail({
      email: emailAddress,
      role: "SUPER_ADMIN",
      inviteUrl: url.toString(),
      expiresAt,
    }),
  );

  await audit.write({
    actorType: "SYSTEM",
    actorId: null,
    action: "staff.bootstrap_created",
    entityType: "StaffUser",
    entityId: staff.id,
    after: { email: emailAddress, forced: force },
  });

  console.log(`Super admin invite created for ${emailAddress}`);
  console.log(`Invite link: ${url.toString()}`);
  console.log(`Expires at: ${expiresAt.toISOString()}`);
}

async function resetMfa(): Promise<void> {
  const emailArg = flag("email") ?? args[1];

  if (!emailArg || !isEmail(emailArg)) {
    fail("Usage: npm run cli -- staff:reset-mfa <email>");
  }

  const emailAddress = normalizeEmail(emailArg);
  const staff = await repo.findStaffByEmail(emailAddress);

  if (!staff) {
    fail(`Staff member ${emailAddress} not found.`);
  }

  if (!staff.mfaEnabledAt && !staff.totpSecretEnc) {
    fail(`Staff member ${emailAddress} does not have MFA enabled.`);
  }

  await repo.updateStaff(staff.id, {
    totpSecretEnc: null,
    totpLastStep: null,
    mfaEnabledAt: null,
    recoveryCodeHashes: [],
  });
  const revoked = await repo.revokeAllStaffSessions(staff.id, "mfa_reset_cli", new Date());

  await audit.write({
    actorType: "SYSTEM",
    actorId: null,
    action: "staff.mfa_reset_break_glass",
    entityType: "StaffUser",
    entityId: staff.id,
    after: { email: staff.email, revokedSessions: revoked.length },
    reason: "cli",
  });

  try {
    await email.send(
      securityAlertEmail({
        email: staff.email,
        message:
          "Your multi-factor authentication was reset by a break-glass administrator. You must enroll again at your next sign-in.",
      }),
    );
  } catch (error) {
    console.error("Email notification failed:", error);
  }

  console.log(`MFA reset for ${staff.email}; ${revoked.length} session(s) revoked.`);
}

try {
  if (command === "staff:create-superadmin") {
    await createSuperAdmin();
  } else if (command === "staff:reset-mfa") {
    await resetMfa();
  } else {
    fail(
      "Usage: npm run cli -- <staff:create-superadmin|staff:reset-mfa> [options]",
    );
  }
} finally {
  await prisma.$disconnect();
}
