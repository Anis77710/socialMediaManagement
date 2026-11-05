import type { Env } from "../../config/env.js";
import { createLocalStorage } from "./local.js";
import { createS3Storage } from "./s3.js";
import type { ObjectStorage } from "./types.js";

export function createStorageFromEnv(env: Env): ObjectStorage {
  if (
    env.STORAGE_DRIVER === "s3" &&
    env.S3_BUCKET &&
    env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY &&
    env.CDN_BASE_URL
  ) {
    return createS3Storage({
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      cdnBaseUrl: env.CDN_BASE_URL,
    });
  }

  return createLocalStorage({
    baseDir: env.LOCAL_STORAGE_DIR,
    publicBaseUrl: env.PUBLIC_API_URL,
    signingSecret: env.TOKEN_ENCRYPTION_KEY,
  });
}

export type { ObjectStorage } from "./types.js";
