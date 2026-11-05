import { describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/crypto.js";
import type { AppError } from "../src/lib/errors.js";
import { createStaffHarness, IP, STRONG_PASSWORD } from "./helpers/staff-harness.js";

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }

  throw new Error("Expected the promise to reject");
}

function inviteToken(url: string): string {
  const token = new URL(url).searchParams.get("token");

  if (!token) {
    throw new Error("Invite URL missing token");
  }

  return token;
}

async function actor(harness: ReturnType<typeof createStaffHarness>) {
  const { staff } = await harness.seedStaff({ mfa: true });

  return staff;
}

describe("staff invitations", () => {
  it("creates a pending staff member and emails an invite", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    const result = await harness.management.createInvite(
      admin,
      { email: "New.Ops@Example.com", name: "New Ops", role: "OPS" },
      { ip: IP },
    );

    expect(result.email).toBe("new.ops@example.com");
    expect(result.devInviteUrl).toContain("accept-invite");
    expect(harness.email.lastTo(result.email)?.subject).toContain("invited");

    const info = await harness.auth.inviteInfo(inviteToken(result.devInviteUrl!));

    expect(info).toEqual({
      email: "new.ops@example.com",
      role: "OPS",
      expiresAt: result.expiresAt,
    });

    const created = await harness.repo.findStaffByEmail("new.ops@example.com");

    expect(created?.status).toBe("INVITED");
    expect(created?.createdById).toBe(admin.id);
  });

  it("replaces an older pending invite", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    const first = await harness.management.createInvite(
      admin,
      { email: "new@example.com", role: "SUPPORT" },
      { ip: IP },
    );
    const second = await harness.management.createInvite(
      admin,
      { email: "new@example.com", role: "REVIEWER" },
      { ip: IP },
    );

    const oldError = await rejection(harness.auth.inviteInfo(inviteToken(first.devInviteUrl!)));
    const info = await harness.auth.inviteInfo(inviteToken(second.devInviteUrl!));

    expect(oldError.code).toBe("INVITE_INVALID");
    expect(info.role).toBe("REVIEWER");
  });

  it("accepts an invite once and activates the account", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    const invite = await harness.management.createInvite(
      admin,
      { email: "new@example.com", role: "SUPPORT" },
      { ip: IP },
    );
    const token = inviteToken(invite.devInviteUrl!);

    const weak = await rejection(
      harness.auth.acceptInvite(
        { token, password: "password123456" },
        { ip: IP },
      ),
    );

    expect(weak.code).toBe("WEAK_PASSWORD");

    const accepted = await harness.auth.acceptInvite(
      { token, password: "Qz9!wN4$xR2^bK7p", name: "New Person" },
      { ip: IP },
    );

    expect(accepted.enrollmentRequired).toBe(true);

    const staff = await harness.repo.findStaffByEmail("new@example.com");

    expect(staff?.status).toBe("ACTIVE");
    expect(staff?.name).toBe("New Person");
    expect(staff?.passwordHash).toBe("fake:Qz9!wN4$xR2^bK7p");

    const reused = await rejection(
      harness.auth.acceptInvite(
        { token, password: "Qz9!wN4$xR2^bK7p" },
        { ip: IP },
      ),
    );

    expect(reused.code).toBe("INVITE_INVALID");
  });

  it("rejects expired invitations", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    const invite = await harness.management.createInvite(
      admin,
      { email: "new@example.com", role: "OPS" },
      { ip: IP },
    );

    harness.advance(72 * 3600 + 1);

    const error = await rejection(
      harness.auth.inviteInfo(inviteToken(invite.devInviteUrl!)),
    );

    expect(error.code).toBe("INVITE_INVALID");
  });

  it("refuses invites for an existing active staff member", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    await harness.seedStaff({ email: "existing@example.com", mfa: true });

    const error = await rejection(
      harness.management.createInvite(
        admin,
        { email: "existing@example.com", role: "OPS" },
        { ip: IP },
      ),
    );

    expect(error.code).toBe("STAFF_EXISTS");
  });

  it("guards self changes and the last active super admin", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);

    const selfRole = await rejection(
      harness.management.updateStaff(admin, admin.id, { role: "OPS" }, { ip: IP }),
    );
    const lastAdmin = await rejection(
      harness.management.updateStaff(admin, admin.id, { status: "DISABLED" }, { ip: IP }),
    );

    expect(selfRole.code).toBe("STAFF_SELF_UPDATE");
    expect(lastAdmin.code).toBe("STAFF_SELF_UPDATE");
  });

  it("prevents demoting the only active super admin", async () => {
    const harness = createStaffHarness();
    const target = await harness.seedStaff({ mfa: true });
    const nonSuperActor = await harness.seedStaff({
      email: "ops@example.com",
      role: "OPS",
      mfa: true,
    });

    const error = await rejection(
      harness.management.updateStaff(
        nonSuperActor.staff,
        target.staff.id,
        { role: "OPS" },
        { ip: IP },
      ),
    );

    expect(error.code).toBe("LAST_SUPER_ADMIN");
  });

  it("revokes sessions and clears MFA on reset", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    const target = await harness.seedStaff({
      email: "target@example.com",
      role: "OPS",
      mfa: true,
    });
    harness.advance(30);
    const session = await harness.loginWithMfa("target@example.com", target.secret!);

    const result = await harness.management.revokeSessions(
      admin,
      target.staff.id,
      { ip: IP },
    );

    expect(result.revoked).toBe(1);
    expect(
      (await harness.repo.findStaffSessionById(
        (
          await harness.repo.findStaffSessionByTokenHash(
            hashToken(session.sessionToken),
          )
        )!.id,
      ))?.revokedAt,
    ).not.toBeNull();

    await harness.management.resetMfa(admin, target.staff.id, { ip: IP });

    const stored = await harness.repo.findStaffById(target.staff.id);

    expect(stored?.mfaEnabledAt).toBeNull();
    expect(stored?.totpSecretEnc).toBeNull();
    expect(stored?.recoveryCodeHashes).toHaveLength(0);
    expect(
      harness.auditRepo.rows.some((row) => row.action === "staff.mfa_reset"),
    ).toBe(true);
    expect(
      harness.email.sent.some((message) => message.to === "target@example.com"),
    ).toBe(true);
  });

  it("requires MFA to be enabled before it can be reset", async () => {
    const harness = createStaffHarness();
    const admin = await actor(harness);
    const target = await harness.seedStaff({
      email: "no-mfa@example.com",
      password: STRONG_PASSWORD,
    });

    const error = await rejection(
      harness.management.resetMfa(admin, target.staff.id, { ip: IP }),
    );

    expect(error.code).toBe("MFA_NOT_ENROLLED");
  });
});
