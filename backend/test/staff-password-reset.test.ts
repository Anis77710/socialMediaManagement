import { describe, expect, it } from "vitest";
import type { AppError } from "../src/lib/errors.js";
import { createStaffHarness, IP } from "./helpers/staff-harness.js";

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }

  throw new Error("Expected the promise to reject");
}

describe("staff password reset", () => {
  it("sends reset mail only for active staff and stays generic", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });
    await harness.seedStaff({
      email: "invited@example.com",
      status: "INVITED",
    });

    await expect(
      harness.auth.forgotPassword({ email: "unknown@example.com" }, { ip: IP }),
    ).resolves.toBeUndefined();
    await expect(
      harness.auth.forgotPassword({ email: "invited@example.com" }, { ip: IP }),
    ).resolves.toBeUndefined();

    expect(
      harness.email.sent.some((message) => message.to === "unknown@example.com"),
    ).toBe(false);
    expect(
      harness.email.sent.some((message) => message.to === "invited@example.com"),
    ).toBe(false);

    await harness.auth.forgotPassword({ email: "admin@example.com" }, { ip: IP });

    expect(harness.email.lastTo("admin@example.com")?.subject).toContain(
      "Reset your Redflie admin password",
    );
  });

  it("resets the password once and revokes existing sessions", async () => {
    const harness = createStaffHarness();
    const { staff, secret } = await harness.seedStaff({ mfa: true });
    harness.advance(30);
    const session = await harness.loginWithMfa("admin@example.com", secret!);
    const token = await harness.passwordResetToken("admin@example.com");
    const newPassword = "Rt5!yK8@pL3#nM6z";

    await harness.auth.resetPassword(
      { token, newPassword },
      { ip: IP },
    );

    const stored = await harness.repo.findStaffById(staff.id);

    expect(stored?.passwordHash).toBe(`fake:${newPassword}`);
    expect(
      (await harness.repo.findStaffSessionByTokenHash(session.sessionToken))
        ?.revokedAt,
    ).not.toBeNull();

    const reused = await rejection(
      harness.auth.resetPassword({ token, newPassword: "Zx4!cV7$bN2%mQ9w" }, { ip: IP }),
    );

    expect(reused.code).toBe("AUTH_INVALID_RESET_TOKEN");

    const login = await harness.login("admin@example.com", newPassword);

    expect(login.requiresMfa).toBe(true);
    expect(login.enrollmentRequired).toBe(false);
  });

  it("still requires the second factor after a reset", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });
    const token = await harness.passwordResetToken("admin@example.com");
    const newPassword = "Rt5!yK8@pL3#nM6z";
    await harness.auth.resetPassword({ token, newPassword }, { ip: IP });

    const login = await harness.login("admin@example.com", newPassword);
    const wrong = await rejection(
      harness.auth.verifyMfa(
        { mfaToken: login.mfaToken, code: "000000" },
        { ip: IP },
      ),
    );

    expect(wrong.code).toBe("AUTH_INVALID_CODE");
  });

  it("rejects expired, unknown, and weak reset attempts", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });
    const token = await harness.passwordResetToken("admin@example.com");

    harness.advance(1800 + 1);

    const expired = await rejection(
      harness.auth.resetPassword(
        { token, newPassword: "Rt5!yK8@pL3#nM6z" },
        { ip: IP },
      ),
    );
    const unknown = await rejection(
      harness.auth.resetPassword(
        { token: "does-not-exist", newPassword: "Rt5!yK8@pL3#nM6z" },
        { ip: IP },
      ),
    );

    expect(expired.code).toBe("AUTH_INVALID_RESET_TOKEN");
    expect(unknown.code).toBe("AUTH_INVALID_RESET_TOKEN");

    const fresh = await harness.passwordResetToken("admin@example.com");
    const weak = await rejection(
      harness.auth.resetPassword(
        { token: fresh, newPassword: "password123456" },
        { ip: IP },
      ),
    );

    expect(weak.code).toBe("WEAK_PASSWORD");
  });

  it("enforces the per-email reset request limit", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await harness.auth.forgotPassword({ email: "admin@example.com" }, { ip: IP });
    }

    const messages = harness.email.sent.filter(
      (message) => message.to === "admin@example.com",
    );

    expect(messages).toHaveLength(3);
  });

  it("writes password reset audit entries", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });
    const token = await harness.passwordResetToken("admin@example.com");

    await harness.auth.resetPassword(
      { token, newPassword: "Rt5!yK8@pL3#nM6z" },
      { ip: IP },
    );

    expect(
      harness.auditRepo.rows.some(
        (row) => row.action === "staff.password_reset_requested",
      ),
    ).toBe(true);
    expect(
      harness.auditRepo.rows.some(
        (row) => row.action === "staff.password_reset_completed",
      ),
    ).toBe(true);
  });
});
