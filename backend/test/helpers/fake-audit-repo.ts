import type { AuditAppend, AuditRepo, AuditRow } from "../../src/lib/audit.js";

export function createFakeAuditRepo() {
  const rows: AuditRow[] = [];
  let sequence = 0;

  const repo: AuditRepo = {
    async last() {
      return (
        [...rows].sort(
          (a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id),
        )[0] ?? null
      );
    },

    async append(entry: AuditAppend) {
      sequence += 1;
      const row: AuditRow = { ...entry, id: `audit_${sequence}` };

      rows.push(row);

      return row;
    },

    async listAll() {
      return [...rows].sort(
        (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
      );
    },
  };

  function tamper(predicate: (row: AuditRow) => boolean): void {
    const row = rows.find(predicate);

    if (!row) {
      throw new Error("No audit row matched");
    }

    row.action = "tampered";
  }

  return { repo, rows, tamper };
}

export type FakeAuditRepo = ReturnType<typeof createFakeAuditRepo>;
