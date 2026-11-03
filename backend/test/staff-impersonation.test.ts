import { decodeJwt } from "jose";
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

function seedCustomer(
  harness: ReturnType<typeof createStaffHarness>,
  id = "customer-1",
) {
  harness.store.customers.set(id, {
    id,
    name: "Customer One",
    phoneE164: "+9779812345678",
    status: "ACTIVE",
  });
}

describe("impersonation", () => {
  it("issues a short-lived read-only token with staff claims", async () => {
    const harness = createStaffHarness();
    const { staff } = await harness.seedStaff({ mfa: true });
    seedCustomer(harness);

    const result = await harness.management.impersonate(
      staff,
      { userId: "customer-1", reason: "Investigating support ticket 1234" },
      { ip: IP, userAgent: "admin-browser" },
    );
    const claims = await harness.tokens.verify(result.accessToken);
    const payload = decodeJwt(result.accessToken);

    expect(claims.sub).toBe("customer-1");
    expect(claims.sid).toBe(`impersonation:${staff.id}`);
    expect(claims.scp).toEqual(["app", "impersonation"]);
    expect(claims.imp).toEqual({
      staffId: staff.id,
      staffEmail: staff.email,
      reason: "Investigating support ticket 1234",
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(1800);
    expect(result.expiresIn).toBe(1800);
    expect(result.user.phoneMasked).not.toContain("9812345678");
  });

  it("audits the action and notifies the customer and super admins", async () => {
    const harness = createStaffHarness();
    const { staff } = await harness.seedStaff({ mfa: true });
    await harness.seedStaff({
      email: "other@example.com",
      mfa: true,
    });
    seedCustomer(harness);

    await harness.management.impersonate(
      staff,
      { userId: "customer-1", reason: "Investigating support ticket 1234" },
      { ip: IP },
    );

    expect(
      harness.auditRepo.rows.some(
        (row) =>
          row.action === "staff.impersonation_started" &&
          row.entityId === "customer-1" &&
          row.reason === "Investigating support ticket 1234",
      ),
    ).toBe(true);
    expect(harness.store.securityEvents).toHaveLength(1);
    expect(harness.store.securityEvents[0]?.type).toBe("ADMIN_IMPERSONATION");
    expect(harness.emitted.some((event) => event.type === "ADMIN_IMPERSONATION")).toBe(
      true,
    );
    expect(
      harness.email.sent.some((message) => message.to === "other@example.com"),
    ).toBe(true);
  });

  it("rejects unknown and deleted customers", async () => {
    const harness = createStaffHarness();
    const { staff } = await harness.seedStaff({ mfa: true });

    const missing = await rejection(
      harness.management.impersonate(
        staff,
        { userId: "missing", reason: "Investigating support ticket 1234" },
        { ip: IP },
      ),
    );

    harness.store.customers.set("deleted", {
      id: "deleted",
      name: null,
      phoneE164: "+9779812345678",
      status: "DELETED",
    });

    const deleted = await rejection(
      harness.management.impersonate(
        staff,
        { userId: "deleted", reason: "Investigating support ticket 1234" },
        { ip: IP },
      ),
    );

    expect(missing.code).toBe("NOT_FOUND");
    expect(deleted.code).toBe("NOT_FOUND");
  });
});
