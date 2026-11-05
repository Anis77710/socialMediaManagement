import { describe, expect, it } from "vitest";
import {
  computeAuditHash,
  createAuditWriter,
  verifyAuditChain,
} from "../src/lib/audit.js";
import { createFakeAuditRepo } from "./helpers/fake-audit-repo.js";

describe("audit chain", () => {
  it("links concurrent writes into a valid hash chain", async () => {
    const fake = createFakeAuditRepo();
    let tick = 0;
    const writer = createAuditWriter({
      repo: fake.repo,
      now: () => new Date(1_700_000_000_000 + tick++),
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writer.write({
          actorType: "SYSTEM",
          action: `test.action.${index}`,
          entityType: "Test",
          entityId: String(index),
          after: { index, nested: { b: 2, a: 1 } },
        }),
      ),
    );

    const rows = await fake.repo.listAll();

    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.id)).size).toBe(20);
    expect(verifyAuditChain(rows)).toEqual({ valid: true });
    expect(rows[0]?.prevHash).toBeNull();
    expect(rows[1]?.prevHash).toBe(rows[0]?.rowHash);
  });

  it("is deterministic regardless of object key order", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const base = {
      at,
      actorType: "STAFF" as const,
      actorId: "staff-1",
      action: "test",
      prevHash: null,
      rowHash: null,
    };
    const a = computeAuditHash(null, { ...base, after: { b: 2, a: 1 } });
    const b = computeAuditHash(null, { ...base, after: { a: 1, b: 2 } });

    expect(a).toBe(b);
  });

  it("detects mutated rows and broken links", async () => {
    const fake = createFakeAuditRepo();
    const writer = createAuditWriter({ repo: fake.repo });
    await writer.write({ actorType: "SYSTEM", action: "one" });
    await writer.write({ actorType: "SYSTEM", action: "two" });
    await writer.write({ actorType: "SYSTEM", action: "three" });

    const rows = await fake.repo.listAll();
    const expected = computeAuditHash(rows[0].rowHash, rows[1]);

    expect(rows[1]?.rowHash).toBe(expected);

    fake.tamper((row) => row.action === "two");

    const result = verifyAuditChain(await fake.repo.listAll());

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("rowHash mismatch");
    }
  });

  it("records staff mutations in the chain", async () => {
    const { createStaffHarness } = await import("./helpers/staff-harness.js");
    const harness = createStaffHarness();
    await harness.seedStaff({ mfa: true });
    await harness.login("admin@example.com");
    await harness.auth.forgotPassword({ email: "admin@example.com" }, { ip: "127.0.0.1" });

    const rows = await harness.auditRepo.repo.listAll();

    expect(rows.length).toBeGreaterThan(0);
    expect(verifyAuditChain(rows)).toEqual({ valid: true });
    expect(rows.some((row) => row.actorType === "SYSTEM")).toBe(true);
  });
});
