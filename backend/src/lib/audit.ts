import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

export type AuditActorType = "STAFF" | "SYSTEM" | "USER";

export type AuditInput = {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  requestId?: string | null;
};

export type AuditRow = AuditInput & {
  id: string;
  at: Date;
  prevHash: string | null;
  rowHash: string | null;
};

export type AuditAppend = Omit<AuditRow, "id">;

export type AuditRepo = {
  last(): Promise<AuditRow | null>;
  append(entry: AuditAppend): Promise<AuditRow>;
  listAll(): Promise<AuditRow[]>;
};

export type AuditWriter = {
  write(input: AuditInput): Promise<AuditRow>;
};

function stableStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "null";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}

function canonicalPayload(input: AuditAppend): string {
  return stableStringify({
    at: input.at.toISOString(),
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    ip: input.ip ?? null,
    requestId: input.requestId ?? null,
  });
}

export function computeAuditHash(prevHash: string | null, input: AuditAppend): string {
  return createHash("sha256")
    .update(`${prevHash ?? ""}\n${canonicalPayload(input)}`)
    .digest("hex");
}

export function createAuditWriter(options: {
  repo: AuditRepo;
  now?: () => Date;
}): AuditWriter {
  const now = options.now ?? (() => new Date());
  let tail: Promise<unknown> = Promise.resolve();

  async function append(input: AuditInput): Promise<AuditRow> {
    const last = await options.repo.last();
    const prevHash = last?.rowHash ?? null;
    const entry: AuditAppend = {
      ...input,
      at: now(),
      prevHash,
      rowHash: null,
    };

    entry.rowHash = computeAuditHash(prevHash, entry);

    return options.repo.append(entry);
  }

  return {
    write(input) {
      const run = tail.then(() => append(input));
      tail = run.catch(() => undefined);

      return run;
    },
  };
}

export function verifyAuditChain(
  rows: AuditRow[],
  options: { startPrevHash?: string | null } = {},
): { valid: true } | { valid: false; brokenAtId: string; reason: string } {
  let prevHash = options.startPrevHash ?? null;

  for (const row of rows) {
    if ((row.prevHash ?? null) !== prevHash) {
      return { valid: false, brokenAtId: row.id, reason: "prevHash mismatch" };
    }

    const expected = computeAuditHash(prevHash, row);

    if (row.rowHash !== expected) {
      return { valid: false, brokenAtId: row.id, reason: "rowHash mismatch" };
    }

    prevHash = row.rowHash;
  }

  return { valid: true };
}

type PrismaAuditRow = {
  id: string;
  at: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  reason: string | null;
  ip: string | null;
  requestId: string | null;
  prevHash: string | null;
  rowHash: string | null;
};

function mapAuditRow(row: PrismaAuditRow): AuditRow {
  return {
    id: row.id,
    at: row.at,
    actorType: row.actorType as AuditActorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    ip: row.ip,
    requestId: row.requestId,
    prevHash: row.prevHash,
    rowHash: row.rowHash,
  };
}

export function createPrismaAuditRepo(prisma: PrismaClient): AuditRepo {
  return {
    async last() {
      const row = await prisma.auditLog.findFirst({
        orderBy: [{ at: "desc" }, { id: "desc" }],
      });

      return row ? mapAuditRow(row) : null;
    },

    async append(entry) {
      const row = await prisma.auditLog.create({
        data: {
          at: entry.at,
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          before: entry.before === undefined ? undefined : (entry.before as Prisma.InputJsonValue),
          after: entry.after === undefined ? undefined : (entry.after as Prisma.InputJsonValue),
          reason: entry.reason,
          ip: entry.ip,
          requestId: entry.requestId,
          prevHash: entry.prevHash,
          rowHash: entry.rowHash,
        },
      });

      return mapAuditRow(row);
    },

    async listAll() {
      const rows = await prisma.auditLog.findMany({
        orderBy: [{ at: "asc" }, { id: "asc" }],
      });

      return rows.map(mapAuditRow);
    },
  };
}
