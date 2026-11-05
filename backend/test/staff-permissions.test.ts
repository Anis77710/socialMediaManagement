import { describe, expect, it } from "vitest";
import {
  hasPermission,
  PERMISSIONS,
  permissionsFor,
} from "../src/lib/permissions.js";

describe("staff permissions", () => {
  it("gives super admins every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission("SUPER_ADMIN", permission)).toBe(true);
    }
  });

  it("keeps the matrix least-privilege", () => {
    expect(hasPermission("OPS", "staff:manage")).toBe(false);
    expect(hasPermission("OPS", "impersonate")).toBe(true);
    expect(hasPermission("FINANCE", "payments:refund")).toBe(true);
    expect(hasPermission("FINANCE", "users:suspend")).toBe(false);
    expect(hasPermission("SUPPORT", "payments:read")).toBe(true);
    expect(hasPermission("SUPPORT", "payments:refund")).toBe(false);
    expect(hasPermission("CONTENT", "content:write")).toBe(true);
    expect(hasPermission("CONTENT", "users:suspend")).toBe(false);
    expect(hasPermission("REVIEWER", "reviews:work")).toBe(true);
    expect(hasPermission("REVIEWER", "users:read")).toBe(false);
  });

  it("returns a copy-safe permission list", () => {
    const permissions = permissionsFor("OPS");

    expect(permissions).toContain("users:read");
    expect(Array.isArray(permissions)).toBe(true);
  });
});
