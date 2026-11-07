import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const version = "v1";

export type SecretBox = {
  activeKid: string;
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
  hasKid(kid: string): boolean;
};

export function createSecretBox(
  keysBase64: Record<string, string>,
  activeKid: string,
): SecretBox {
  const keys = new Map<string, Buffer>();

  for (const [kid, value] of Object.entries(keysBase64)) {
    const key = Buffer.from(value, "base64");

    if (key.length !== 32) {
      throw new Error(`Encryption key ${kid} must be 32 bytes`);
    }

    keys.set(kid, key);
  }

  if (!keys.has(activeKid)) {
    throw new Error(`Active encryption key ${activeKid} is not configured`);
  }

  return {
    activeKid,

    encrypt(plaintext) {
      const key = keys.get(activeKid) as Buffer;
      const iv = randomBytes(12);
      const cipher = createCipheriv(algorithm, key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        version,
        activeKid,
        iv.toString("base64url"),
        authTag.toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },

    decrypt(payload) {
      const [payloadVersion, kid, ivPart, authTagPart, encryptedPart] = payload.split(".");

      if (payloadVersion !== version || !kid || !ivPart || !authTagPart || !encryptedPart) {
        throw new Error("Invalid encrypted payload format");
      }

      const key = keys.get(kid);

      if (!key) {
        throw new Error(`Unknown encryption key ${kid}`);
      }

      const decipher = createDecipheriv(algorithm, key, Buffer.from(ivPart, "base64url"));
      decipher.setAuthTag(Buffer.from(authTagPart, "base64url"));

      return Buffer.concat([
        decipher.update(Buffer.from(encryptedPart, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },

    hasKid(kid) {
      return keys.has(kid);
    },
  };
}
