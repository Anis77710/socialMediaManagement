import { describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/crypto.js";
import type { AppError } from "../src/lib/errors.js";
import {
  createStaffHarness,
  IP,
  STRONG_PASSWORD,
} from "./helpers/staff-harness.js";

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }

  throw new Error("Expected the promise to reject");
}

async function sessionLogin(
  harness: ReturnType<typeof createStaffHarness>,
  secret: string,
  email = "admin@example.com",
  ctx: { ip?: string; userAgent?: string } = {},
) {
  harness.advance(30);

  return harness.loginWithMfa(email, secret, ctx);
}

describe("staff sessions", () => {
  it("evicts the oldest session when the cap is reached", async () => {
    const harness = createStaffHarness();
    const { secret } = await harness.seedStaff({ mfa: true });
    const staff = (await harness.repo.findStaffByEmail("admin@example.com"))!;

    const first = await sessionLogin(harness, secret!);
    await sessionLogin(harness, secret!);
    await sessionLogin(harness, secret!);
    const fourth = await sessionLogin(harness, secret!);

    const active = [...harness.store.sessions.values()].filter(
      (session) =>
        session.staffId === staff.id &&
        !session.revokedAt &&
        session.absoluteExpiresAt > harness.now(),
    );
    const evicted = await harness.repo.findStaffSessionByTokenHash(
      hashToken(first.sessionToken),
    );

    expect(active).toHaveLength(3);
    expect(evicted?.revokedAt).not.toBeNull();
    expect(evicted?.revokeReason).toBe("max_sessions");
    expect(harness.revokedBatches.some((ids) => ids.includes(evicted!.id))).toBe(true);
    expect(fourth.sessionToken).toBeTruthy();
  });

  it("revokes every session on logout-all", async () => {
    const harness = createStaffHarness();
    const { secret } = await harness.seedStaff({ mfa: true });
    const staff = (await harness.repo.findStaffByEmail("admin@example.com"))!;

    await sessionLogin(harness, secret!);
    await sessionLogin(harness, secret!);
    await harness.auth.logoutAll(staff.id, { ip: IP });

    const active = await harness.repo.countActiveStaffSessions(staff.id, harness.now());

    expect(active).toBe(0);
    expect(harness.revokedBatches.flat().length).toBe(2);
  });

  it("lists active sessions and marks the current one", async () => {
    const harness = createStaffHarness();
    const { secret } = await harness.seedStaff({ mfa: true });
    const staff = (await harness.repo.findStaffByEmail("admin@example.com"))!;

    await sessionLogin(harness, secret!, "admin@example.com", { userAgent: "agent-a" });
    const current = await sessionLogin(harness, secret!, "admin@example.com", {
      userAgent: "agent-b",
    });
    const currentId = (
      await harness.repo.findStaffSessionByTokenHash(hashToken(current.sessionToken))
    )!.id;

    const sessions = await harness.auth.listSessions(staff.id, currentId);

    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(sessions.find((session) => session.current)?.userAgent).toBe("agent-b");
    expect(sessions.find((session) => session.current)?.ipMasked).not.toBe(IP);
  });

  it("revokes one session but not sessions owned by another staff member", async () => {
    const harness = createStaffHarness();
    const first = await harness.seedStaff({ mfa: true });
    const second = await harness.seedStaff({
      email: "other@example.com",
      mfa: true,
    });
    const firstStaff = (await harness.repo.findStaffByEmail("admin@example.com"))!;
    const secondStaff = (await harness.repo.findStaffByEmail("other@example.com"))!;
    const firstSession = await sessionLogin(harness, first.secret!);
    const secondSession = await sessionLogin(harness, second.secret!, "other@example.com");
    const secondSessionId = (
      await harness.repo.findStaffSessionByTokenHash(
        hashToken(secondSession.sessionToken),
      )
    )!.id;

    const error = await rejection(
      harness.auth.revokeSession(firstStaff.id, secondSessionId, { ip: IP }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(
      (await harness.repo.findStaffSessionById(secondSessionId))?.revokedAt,
    ).toBeNull();
    expect(
      await harness.repo.countActiveStaffSessions(secondStaff.id, harness.now()),
    ).toBe(1);

    await harness.auth.logout(
      firstStaff.id,
      (await harness.repo.findStaffSessionByTokenHash(hashToken(firstSession.sessionToken)))!
        .id,
      { ip: IP },
    );

    expect(
      await harness.repo.countActiveStaffSessions(firstStaff.id, harness.now()),
    ).toBe(0);
  });

  it("rotates the password and revokes other sessions", async () => {
    const harness = createStaffHarness();
    const { staff, secret } = await harness.seedStaff({ mfa: true });
    const oldSession = await sessionLogin(harness, secret!);
    const current = await sessionLogin(harness, secret!);
    const currentId = (
      await harness.repo.findStaffSessionByTokenHash(hashToken(current.sessionToken))
    )!.id;

    await harness.auth.changePassword(
      {
        staffId: staff.id,
        sessionId: currentId,
        currentPassword: STRONG_PASSWORD,
        newPassword: "Nq8$vT2wZ!4rLp7K",
      },
      { ip: IP },
    );

    const stored = await harness.repo.findStaffById(staff.id);

    expect(stored?.passwordHash).toBe("fake:Nq8$vT2wZ!4rLp7K");
    expect(
      (await harness.repo.findStaffSessionById(currentId))?.revokedAt,
    ).toBeNull();
    expect(
      (
        await harness.repo.findStaffSessionByTokenHash(hashToken(oldSession.sessionToken))
      )?.revokedAt,
    ).not.toBeNull();
    expect(harness.email.lastTo(staff.email)?.subject).toContain("password was changed");
  });

  it("rejects a reused or weak replacement password", async () => {
    const harness = createStaffHarness();
    const { staff, secret } = await harness.seedStaff({ mfa: true });
    const session = await sessionLogin(harness, secret!);
    const sessionId = (
      await harness.repo.findStaffSessionByTokenHash(hashToken(session.sessionToken))
    )!.id;

    const reused = await rejection(
      harness.auth.changePassword(
        {
          staffId: staff.id,
          sessionId,
          currentPassword: STRONG_PASSWORD,
          newPassword: STRONG_PASSWORD,
        },
        { ip: IP },
      ),
    );
    const weak = await rejection(
      harness.auth.changePassword(
        {
          staffId: staff.id,
          sessionId,
          currentPassword: STRONG_PASSWORD,
          newPassword: "password123456",
        },
        { ip: IP },
      ),
    );

    expect(reused.code).toBe("PASSWORD_REUSED");
    expect(weak.code).toBe("WEAK_PASSWORD");
  });

  it("sets a step-up window only with a valid password and code", async () => {
    const harness = createStaffHarness();
    const { staff, secret } = await harness.seedStaff({ mfa: true });
    const session = await sessionLogin(harness, secret!);
    const sessionId = (
      await harness.repo.findStaffSessionByTokenHash(hashToken(session.sessionToken))
    )!.id;

    const wrongPassword = await rejection(
      harness.auth.stepUp(
        {
          staffId: staff.id,
          sessionId,
          password: "wrong-password",
          code: "000000",
        },
        { ip: IP },
      ),
    );
    const wrongCode = await rejection(
      harness.auth.stepUp(
        {
          staffId: staff.id,
          sessionId,
          password: STRONG_PASSWORD,
          code: "000000",
        },
        { ip: IP },
      ),
    );
    const code = await harness.totp.code(secret!);
    const result = await harness.auth.stepUp(
      {
        staffId: staff.id,
        sessionId,
        password: STRONG_PASSWORD,
        code,
      },
      { ip: IP },
    );

    expect(wrongPassword.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(wrongCode.code).toBe("AUTH_INVALID_CODE");
    expect(result.expiresIn).toBe(300);
    expect(
      (await harness.repo.findStaffSessionById(sessionId))?.stepUpUntil,
    ).toEqual(result.stepUpUntil);
  });
});
