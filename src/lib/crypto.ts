import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const algorithm = "aes-256-gcm";
const encryptionKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptToken(payload: string): string {
  const [ivPart, authTagPart, encryptedPart] = payload.split(".");

  if (!ivPart || !authTagPart || !encryptedPart) {
    throw new Error("Invalid encrypted token format");
  }

  const decipher = createDecipheriv(algorithm, encryptionKey, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
