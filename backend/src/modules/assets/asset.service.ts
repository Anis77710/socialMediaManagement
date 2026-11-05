import { createHash, randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { ObjectStorage } from "../../providers/storage/types.js";

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export type AssetService = ReturnType<typeof createAssetService>;

function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "application/pdf": "pdf",
  };

  return map[mime] ?? "bin";
}

export function createAssetService(deps: {
  prisma: PrismaClient;
  storage: ObjectStorage;
  maxBytes: number;
}) {
  function keyFor(businessId: string, kind: string, mime: string): string {
    return `biz/${businessId}/${kind}/${randomUUID()}.${extensionFor(mime)}`;
  }

  async function createRecord(input: {
    businessId: string;
    kind: string;
    storageKey: string;
    mime: string;
    bytes: number;
    sha256: string;
    width?: number | null;
    height?: number | null;
    isPublic?: boolean;
  }) {
    return deps.prisma.asset.create({
      data: {
        businessId: input.businessId,
        kind: input.kind,
        storageKey: input.storageKey,
        mime: input.mime,
        bytes: input.bytes,
        sha256: input.sha256,
        width: input.width ?? null,
        height: input.height ?? null,
        isPublic: input.isPublic ?? false,
      },
    });
  }

  async function upload(input: {
    businessId: string;
    kind: string;
    buffer: Buffer;
    declaredMime: string;
    isPublic?: boolean;
  }) {
    if (input.buffer.length === 0) {
      throw new AppError(400, "EMPTY_FILE", "The uploaded file is empty");
    }

    if (input.buffer.length > deps.maxBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", "The uploaded file is too large", {
        maxBytes: deps.maxBytes,
      });
    }

    const detected = await fileTypeFromBuffer(input.buffer);
    const mime = detected?.mime ?? input.declaredMime;

    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Only image uploads are supported", { mime });
    }

    const storageKey = keyFor(input.businessId, input.kind, mime);
    await deps.storage.put(storageKey, input.buffer, mime);

    return createRecord({
      businessId: input.businessId,
      kind: input.kind,
      storageKey,
      mime,
      bytes: input.buffer.length,
      sha256: createHash("sha256").update(input.buffer).digest("hex"),
      isPublic: input.isPublic ?? false,
    });
  }

  async function saveBuffer(input: {
    businessId: string;
    kind: string;
    buffer: Buffer;
    mime: string;
    isPublic?: boolean;
    width?: number | null;
    height?: number | null;
  }) {
    const storageKey = keyFor(input.businessId, input.kind, input.mime);
    await deps.storage.put(storageKey, input.buffer, input.mime);

    return createRecord({
      businessId: input.businessId,
      kind: input.kind,
      storageKey,
      mime: input.mime,
      bytes: input.buffer.length,
      sha256: createHash("sha256").update(input.buffer).digest("hex"),
      isPublic: input.isPublic ?? false,
      width: input.width ?? null,
      height: input.height ?? null,
    });
  }

  async function presign(input: {
    businessId: string;
    kind: string;
    mime: string;
    bytes: number;
  }) {
    if (!ALLOWED_IMAGE_MIME.has(input.mime)) {
      throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "Only image uploads are supported");
    }

    if (input.bytes <= 0 || input.bytes > deps.maxBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", "The uploaded file is too large", {
        maxBytes: deps.maxBytes,
      });
    }

    const storageKey = keyFor(input.businessId, input.kind, input.mime);
    const uploadUrl = await deps.storage.presignPut(
      storageKey,
      input.mime,
      deps.maxBytes,
      900,
    );

    return { key: storageKey, uploadUrl, expiresInSec: 900 };
  }

  async function complete(input: {
    businessId: string;
    key: string;
    kind: string;
    mime: string;
    bytes: number;
    width?: number | null;
    height?: number | null;
    isPublic?: boolean;
  }) {
    if (!input.key.startsWith(`biz/${input.businessId}/`)) {
      throw new AppError(403, "INVALID_STORAGE_KEY", "This storage key belongs to another business");
    }

    if (!(await deps.storage.exists(input.key))) {
      throw new AppError(409, "UPLOAD_NOT_FOUND", "The uploaded object was not found");
    }

    return createRecord({
      businessId: input.businessId,
      kind: input.kind,
      storageKey: input.key,
      mime: input.mime,
      bytes: input.bytes,
      sha256: createHash("sha256").update(input.key).digest("hex"),
      width: input.width ?? null,
      height: input.height ?? null,
      isPublic: input.isPublic ?? false,
    });
  }

  async function list(businessId: string, kind?: string, limit = 50) {
    return deps.prisma.asset.findMany({
      where: { businessId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async function get(businessId: string, id: string) {
    const asset = await deps.prisma.asset.findFirst({ where: { id, businessId } });

    if (!asset) {
      throw AppError.notFound("Asset not found");
    }

    return asset;
  }

  async function remove(businessId: string, id: string) {
    const asset = await get(businessId, id);
    await deps.storage.remove(asset.storageKey);
    await deps.prisma.asset.delete({ where: { id: asset.id } });
  }

  async function urlFor(asset: { storageKey: string; isPublic: boolean }) {
    return asset.isPublic
      ? deps.storage.publicUrl(asset.storageKey)
      : deps.storage.presignGet(asset.storageKey, 900);
  }

  return { upload, saveBuffer, presign, complete, list, get, remove, urlFor };
}
