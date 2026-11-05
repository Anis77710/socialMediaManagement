import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import { createStaffHarness, IP, STRONG_PASSWORD } from "./helpers/staff-harness.js";

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error("Expected the promise to reject");
}

describe("staff login", () => {
  it("does not reveal whether an email exists", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });

    const unknown = await rejection(harness.login("nobody@example.com", STRONG_PASSWORD));
    const wrong = await rejection(harness.login("admin@example.com", "wrong-password"));

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(wrong.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(unknown.message).toBe(wrong.message);
  });

  it("treats disabled accounts like invalid credentials", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ password: STRONG_PASSWORD, status: "DISABLED", mfa: true });

    const error = await rejection(harness.login("admin@example.com"));

    expect(error.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("returns an MFA token after a valid password", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });

    const result = await harness.login(" Admin@Example.com ");

    expect(result.requiresMfa).toBe(true);
    expect(result.enrollmentRequired).toBe(false);
    expect(result.mfaToken).toBeTruthy();
    expect(harness.auditRepo.rows.some((row) => row.action === "staff.login_password_verified")).toBe(
      true,
    );
  });

  it("requires enrollment when MFA has not been set up", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ password: STRONG_PASSWORD });

    const result = await harness.login("admin@example.com");

    expect(result.enrollmentRequired).toBe(true);
  });

  it("locks the account after five failed passwords and unlocks later", async () => {
    const harness = createStaffHarness();
    const { staff } = await harness.seedStaff({ mfa: true });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await rejection(harness.login("admin@example.com", "wrong-password"));
    }

    const locked = await harness.repo.findStaffById(staff.id);

    expect(locked?.lockedUntil).not.toBeNull();
    expect(locked?.failedLogins).toBe(5);

    const whileLocked = await rejection(harness.login("admin@example.com"));

    expect(whileLocked.code).toBe("AUTH_INVALID_CREDENTIALS");

    harness.advance(15 * 60 + 1);

    const result = await harness.login("admin@example.com");

    expect(result.requiresMfa).toBe(true);
  });

  it("throttles repeated attempts from one IP", async () => {
    const harness = createStaffHarness({ config: { loginIpLimit: 2 } });

    await rejection(harness.login("a@example.com", "wrong-password", { ip: IP }));
    await rejection(harness.login("b@example.com", "wrong-password", { ip: IP }));

    const error = await rejection(
      harness.login("c@example.com", "wrong-password", { ip: IP }),
    );

    expect(error.statusCode).toBe(429);
    expect(error.code).toBe("AUTH_TOO_MANY_ATTEMPTS");
  });

  it("alerts super admins when the lockout threshold is reached", async () => {
    const harness = createStaffHarness({ config: { lockoutAlertThreshold: 5 } });
    await harness.seedStaff({ mfa: true });
    await harness.seedStaff({ email: "other-super@example.com", mfa: true });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await rejection(harness.login("admin@example.com", "wrong-password"));
    }

    expect(
      harness.email.sent.some(
        (message) =>
          message.to === "other-super@example.com" &&
          message.subject === "Redflie admin security alert",
      ),
    ).toBe(true);
  });

  it("records failed attempts without storing the email in plain text", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });

    await rejection(harness.login("admin@example.com", "wrong-password"));

    expect(harness.store.attempts).toHaveLength(1);
    expect(harness.store.attempts[0]?.emailHash).not.toContain("@");
    expect(harness.store.attempts[0]?.reason).toBe("invalid_password");
  });
});
