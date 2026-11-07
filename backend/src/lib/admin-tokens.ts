import { randomUUID } from "node:crypto";
import { decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";

const ISSUER = "redflie";
const AUDIENCE = "admin";

export type AdminPreAuthPurpose = "mfa" | "enroll";

export type AdminPreAuthClaims = {
  staffId: string;
  purpose: AdminPreAuthPurpose;
  jti: string;
};

export type AdminPreAuthConfig = {
  privateKeyBase64: string;
  publicKeysBase64: Record<string, string>;
  kid: string;
  ttlSec: number;
};

export type AdminPreAuthService = {
  ttlSec: number;
  sign(input: { staffId: string; purpose: AdminPreAuthPurpose }): Promise<string>;
  verify(token: string): Promise<AdminPreAuthClaims>;
};

export class AdminPreAuthError extends Error {
  constructor(message = "Invalid admin token") {
    super(message);
    this.name = "AdminPreAuthError";
  }
}

function decodePem(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

export function createAdminPreAuthService(config: AdminPreAuthConfig): AdminPreAuthService {
  const privateKey = importPKCS8(decodePem(config.privateKeyBase64), "ES256");
  const publicKeys = new Map(
    Object.entries(config.publicKeysBase64).map(([kid, pem]) => [
      kid,
      importSPKI(decodePem(pem), "ES256"),
    ]),
  );

  return {
    ttlSec: config.ttlSec,

    async sign({ staffId, purpose }) {
      return new SignJWT({ purpose, jti: randomUUID() })
        .setProtectedHeader({ alg: "ES256", kid: config.kid })
        .setSubject(staffId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.ttlSec}s`)
        .sign(await privateKey);
    },

    async verify(token) {
      const header = decodeProtectedHeader(token);
      const key = header.kid ? publicKeys.get(header.kid) : undefined;

      if (!key) {
        throw new AdminPreAuthError("Unknown signing key");
      }

      try {
        const { payload } = await jwtVerify(token, await key, {
          algorithms: ["ES256"],
          issuer: ISSUER,
          audience: AUDIENCE,
        });

        if (
          typeof payload.sub !== "string" ||
          (payload.purpose !== "mfa" && payload.purpose !== "enroll") ||
          typeof payload.jti !== "string"
        ) {
          throw new AdminPreAuthError("Malformed admin token");
        }

        return {
          staffId: payload.sub,
          purpose: payload.purpose,
          jti: payload.jti,
        };
      } catch (error) {
        if (error instanceof AdminPreAuthError) {
          throw error;
        }

        throw new AdminPreAuthError();
      }
    },
  };
}
