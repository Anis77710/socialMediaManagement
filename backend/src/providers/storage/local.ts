import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type { ObjectStorage } from "./types.js";

function safeKey(key: string): string {
  const normalized = normalize(key).replace(/\\/g, "/");

  if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("\0")) {
    throw new Error("Invalid storage key");
  }

  return normalized.replace(/^\/+/, "");
}

export function createLocalStorage(options: {
  baseDir: string;
  publicBaseUrl: string;
  signingSecret: string;
}): ObjectStorage & {
  verifyUpload(key: string, expires: string, signature: string): boolean;
} {
  const root = resolve(options.baseDir);

  function pathFor(key: string): string {
    return join(root, safeKey(key));
  }

  function sign(key: string, expires: number): string {
    return createHmac("sha256", options.signingSecret)
      .update(`${key}:${expires}`)
      .digest("base64url");
  }

  function publicUrl(key: string): string {
    return `${options.publicBaseUrl.replace(/\/$/, "")}/v1/public/media/${encodeURI(safeKey(key))}`;
  }

  return {
    name: "local",

    async put(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },

    async get(key) {
      return readFile(pathFor(key));
    },

    async exists(key) {
      try {
        await readFile(pathFor(key));

        return true;
      } catch {
        return false;
      }
    },

    async presignPut(key, _mime, _maxBytes, ttlSec = 900) {
      const expires = Math.floor(Date.now() / 1000) + ttlSec;
      const signature = sign(safeKey(key), expires);

      return `${options.publicBaseUrl.replace(/\/$/, "")}/v1/public/storage/${encodeURI(
        safeKey(key),
      )}?expires=${expires}&signature=${signature}`;
    },

    async presignGet(key, ttlSec) {
      const expires = Math.floor(Date.now() / 1000) + ttlSec;
      const signature = sign(safeKey(key), expires);

      return `${publicUrl(key)}?expires=${expires}&signature=${signature}`;
    },

    async remove(key) {
      await rm(pathFor(key), { force: true });
    },

    publicUrl,

    verifyUpload(key, expires, signature) {
      const expected = sign(safeKey(key), Number(expires));
      const left = Buffer.from(expected);
      const right = Buffer.from(signature);

      return (
        left.length === right.length &&
        timingSafeEqual(left, right) &&
        Number(expires) * 1000 > Date.now()
      );
    },
  };
}
