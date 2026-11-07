import { AppError } from "./errors.js";

export type Cursor = { createdAt: string; id: string };

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Cursor).createdAt === "string" &&
      typeof (parsed as Cursor).id === "string" &&
      !Number.isNaN(Date.parse((parsed as Cursor).createdAt))
    ) {
      return parsed as Cursor;
    }
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
  }

  throw new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
}

export type CursorWhere =
  | Record<string, never>
  | {
      OR: ({ createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } })[];
    };

export function cursorWhere(cursor: Cursor | null): CursorWhere {
  if (!cursor) {
    return {};
  }

  const createdAt = new Date(cursor.createdAt);

  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}

export function pageResult<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
