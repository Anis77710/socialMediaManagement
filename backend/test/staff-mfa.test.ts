import { describe, expect, it } from "vitest";
import type { AppError } from "../src/lib/errors.js";
import { createStaffHarness, STRONG_PASSWORD } from "./helpers/staff-harness.js";

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }

  throw new Error("Expected the promise to reject");
}

async function enroll(harness: ReturnType<typeof createStaffHarness>) {
  const { staff } = await harness.seedStaff({ password: STRONG_PASSWORD });
  const login = await harness.login(staff.email);
  const started = await harness.auth.startEnrollment(
    { mfaToken: login.mfaToken },
    { ip: "203.0.113.10" },
  );
  const code = await harness.totp.code(started.secret);
  const confirmed = await harness.auth.confirmEnrollment(
    { mfaToken: login.mfaToken, code },
    { ip: "203.0.113.10", userAgent: "test-agent" },
  );

  return { staff, started, confirmed };
}

describe("staff MFA", () => {
  it("enrolls a new staff member and returns single-use recovery codes", async () => {
    const harness = createStaffHarness();
    const { staff, started, confirmed } = await enroll(harness);

    expect(started.secret).toBeTruthy();
    expect(started.otpauthUri).toContain("otpauth://totp/");
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(confirmed.sessionToken).toBeTruthy();
    expect(confirmed.staff.mfaEnabled).toBe(true);

    const stored = await harness.repo.findStaffById(staff.id);

    expect(stored?.mfaEnabledAt).not.toBeNull();
    expect(stored?.recoveryCodeHashes).toHaveLength(10);
  });

  it("rejects an invalid enrollment code without burning the token", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ password: STRONG_PASSWORD });
    const login = await harness.login("admin@example.com");
    const started = await harness.auth.startEnrollment(
      { mfaToken: login.mfaToken },
      { ip: "203.0.113.10" },
    );

    const error = await rejection(
      harness.auth.confirmEnrollment(
        { mfaToken: login.mfaToken, code: "000000" },
        { ip: "203.0.113.10" },
      ),
    );

    expect(error.code).toBe("AUTH_INVALID_CODE");

    const code = await harness.totp.code(started.secret);
    const confirmed = await harness.auth.confirmEnrollment(
      { mfaToken: login.mfaToken, code },
      { ip: "203.0.113.10" },
    );

    expect(confirmed.sessionToken).toBeTruthy();
  });

  it("consumes the MFA token after a successful verification", async () => {
    const harness = createStaffHarness();
    const { secret } = await harness.seedStaff({ mfa: true });
    const login = await harness.login("admin@example.com");
    await harness.completeMfa(login.mfaToken, secret!);

    harness.advance(30);

    const error = await rejection(
      harness.completeMfa(login.mfaToken, secret!),
    );

    expect(error.code).toBe("AUTH_INVALID_MFA_TOKEN");
  });

  it("rejects a replayed TOTP code", async () => {
    const harness = createStaffHarness();
    const { staff, secret } = await harness.seedStaff({ mfa: true });
    const first = await harness.login("admin@example.com");
    await harness.completeMfa(first.mfaToken, secret!);

    const code = await harness.totp.code(secret!);
    const second = await harness.login("admin@example.com", STRONG_PASSWORD);

    const error = await rejection(
      harness.auth.verifyMfa(
        { mfaToken: second.mfaToken, code },
        { ip: "203.0.113.10" },
      ),
    );

    expect(error.code).toBe("AUTH_INVALID_CODE");

    const stored = await harness.repo.findStaffById(staff.id);

    expect(stored?.totpLastStep).not.toBeNull();
  });

  it("accepts recovery codes once and normalizes formatting", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });
    const enrollment = await enrollRecoveryCodes(harness);
    const recovery = enrollment.recoveryCodes[0];
    const login = await harness.login("admin@example.com");
    const session = await harness.auth.verifyMfa(
      { mfaToken: login.mfaToken, recoveryCode: recovery.toLowerCase().replace("-", " ") },
      { ip: "203.0.113.10" },
    );

    expect(session.sessionToken).toBeTruthy();

    const next = await harness.login("admin@example.com");
    const error = await rejection(
      harness.auth.verifyMfa(
        { mfaToken: next.mfaToken, recoveryCode: recovery },
        { ip: "203.0.113.10" },
      ),
    );

    expect(error.code).toBe("AUTH_INVALID_CODE");
  });

  it("rejects an enrollment token at the MFA endpoint", async () => {
    const harness = createStaffHarness();
    await harness.seedStaff({ password: STRONG_PASSWORD });
    const login = await harness.login("admin@example.com");

    const error = await rejection(
      harness.auth.verifyMfa(
        { mfaToken: login.mfaToken, code: "000000" },
        { ip: "203.0.113.10" },
      ),
    );

    expect(error.code).toBe("AUTH_INVALID_MFA_TOKEN");
  });

  it("refuses enrollment when MFA is already enabled", async () => {
    const harness = createStaffHarness();
    const { staff } = await harness.seedStaff({ mfa: true });
    const enrollmentToken = await harness.preAuth.sign({
      staffId: staff.id,
      purpose: "enroll",
    });

    const error = await rejection(
      harness.auth.startEnrollment(
        { mfaToken: enrollmentToken },
        { ip: "203.0.113.10" },
      ),
    );

    expect(error.code).toBe("MFA_ALREADY_ENABLED");
  });

  it("blocks disabled staff before verifying a code", async () => {
    const harness = createStaffHarness();
    const { staff, secret } = await harness.seedStaff({ mfa: true });
    const login = await harness.login("admin@example.com");
    await harness.repo.updateStaff(staff.id, { status: "DISABLED" });

    const error = await rejection(harness.completeMfa(login.mfaToken, secret!));

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("STAFF_DISABLED");
  });
});

async function enrollRecoveryCodes(harness: ReturnType<typeof createStaffHarness>) {
  const staff = await harness.repo.findStaffByEmail("admin@example.com");

  return harness.auth.regenerateRecoveryCodes(staff!.id, {
    ip: "203.0.113.10",
  });
}
