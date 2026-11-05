import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "./types.js";

export function createS3Storage(options: {
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  cdnBaseUrl: string;
}): ObjectStorage {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    name: "s3",

    async put(key, body, mime) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: body,
          ContentType: mime,
        }),
      );
    },

    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: options.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();

      return Buffer.from(bytes ?? new Uint8Array());
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }));

        return true;
      } catch {
        return false;
      }
    },

    async presignPut(key, mime, maxBytes, ttlSec = 900) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          ContentType: mime,
        }),
        { expiresIn: ttlSec },
      );
    },

    async presignGet(key, ttlSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: options.bucket, Key: key }), {
        expiresIn: ttlSec,
      });
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },

    publicUrl(key) {
      return `${options.cdnBaseUrl.replace(/\/$/, "")}/${key.replace(/^\/+/, "")}`;
    },
  };
}
