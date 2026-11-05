import { decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";

const ISSUER = "redflie";
const AUDIENCE = "app";

export type ImpersonationClaims = {
  staffId: string;
  staffEmail: string;
  reason: string;
};

export type FullAccessClaims = {
  sub: string;
  sid: string;
  tv: number;
  scp: string[];
  imp?: ImpersonationClaims;
};

export type RestrictedClaims = {
  sub: string;
  gsub: string;
  gemail?: string;
  gname?: string;
  scp: string[];
};

export type RestrictedIdentity = {
  sub: string;
  email?: string;
  name?: string;
};

export type TokenServiceConfig = {
  privateKeyBase64: string;
  publicKeysBase64: Record<string, string>;
  kid: string;
  accessTtlSec: number;
};

export type TokenService = {
  accessTtlSec: number;
  signFull(input: {
    userId: string;
    sessionId: string;
    tokenVersion: number;
    scopes?: string[];
    impersonation?: ImpersonationClaims;
  }): Promise<string>;
  signImpersonation(input: {
    userId: string;
    staffId: string;
    staffEmail: string;
    reason: string;
  }): Promise<string>;
  signRestricted(identity: RestrictedIdentity): Promise<string>;
  verify(token: string): Promise<FullAccessClaims>;
  verifyRestricted(token: string): Promise<RestrictedClaims>;
};

export class TokenError extends Error {
  constructor(message = "Invalid token") {
    super(message);
    this.name = "TokenError";
  }
}

function decodePem(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

export function createTokenService(config: TokenServiceConfig): TokenService {
  const privateKey = importPKCS8(decodePem(config.privateKeyBase64), "ES256");
  const publicKeys = new Map(
    Object.entries(config.publicKeysBase64).map(([kid, pem]) => [
      kid,
      importSPKI(decodePem(pem), "ES256"),
    ]),
  );

  async function sign(
    payload: Record<string, unknown>,
    subject: string,
    ttlSec = config.accessTtlSec,
  ): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: config.kid })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(await privateKey);
  }

  async function verifyPayload(token: string) {
    const header = decodeProtectedHeader(token);
    const key = header.kid ? publicKeys.get(header.kid) : undefined;

    if (!key) {
      throw new TokenError("Unknown signing key");
    }

    try {
      const { payload } = await jwtVerify(token, await key, {
        algorithms: ["ES256"],
        issuer: ISSUER,
        audience: AUDIENCE,
      });

      return payload;
    } catch {
      throw new TokenError();
    }
  }

  return {
    accessTtlSec: config.accessTtlSec,

    async signFull({ userId, sessionId, tokenVersion, scopes = ["app"], impersonation }) {
      return sign(
        {
          sid: sessionId,
          tv: tokenVersion,
          scp: scopes,
          ...(impersonation ? { imp: impersonation } : {}),
        },
        userId,
      );
    },

    async signImpersonation({ userId, staffId, staffEmail, reason }) {
      return sign(
        {
          sid: `impersonation:${staffId}`,
          tv: 0,
          scp: ["app", "impersonation"],
          imp: { staffId, staffEmail, reason },
        },
        userId,
        1800,
      );
    },

    async signRestricted(identity) {
      return sign(
        {
          gsub: identity.sub,
          ...(identity.email ? { gemail: identity.email } : {}),
          ...(identity.name ? { gname: identity.name } : {}),
          scp: ["complete-profile"],
        },
        `google:${identity.sub}`,
      );
    },

    async verify(token) {
      const payload = await verifyPayload(token);

      if (
        typeof payload.sub !== "string" ||
        typeof payload.sid !== "string" ||
        typeof payload.tv !== "number" ||
        !Array.isArray(payload.scp)
      ) {
        throw new TokenError("Malformed access token");
      }

      const impersonation =
        typeof payload.imp === "object" &&
        payload.imp !== null &&
        typeof (payload.imp as Record<string, unknown>).staffId === "string" &&
        typeof (payload.imp as Record<string, unknown>).staffEmail === "string" &&
        typeof (payload.imp as Record<string, unknown>).reason === "string"
          ? {
              staffId: (payload.imp as Record<string, string>).staffId,
              staffEmail: (payload.imp as Record<string, string>).staffEmail,
              reason: (payload.imp as Record<string, string>).reason,
            }
          : undefined;

      return {
        sub: payload.sub,
        sid: payload.sid,
        tv: payload.tv,
        scp: payload.scp.filter((scope): scope is string => typeof scope === "string"),
        ...(impersonation ? { imp: impersonation } : {}),
      };
    },

    async verifyRestricted(token) {
      const payload = await verifyPayload(token);
      const scopes = Array.isArray(payload.scp) ? payload.scp : [];

      if (
        typeof payload.gsub !== "string" ||
        typeof payload.sub !== "string" ||
        !scopes.includes("complete-profile")
      ) {
        throw new TokenError("Not a restricted token");
      }

      return {
        sub: payload.sub,
        gsub: payload.gsub,
        ...(typeof payload.gemail === "string" ? { gemail: payload.gemail } : {}),
        ...(typeof payload.gname === "string" ? { gname: payload.gname } : {}),
        scp: scopes.filter((scope): scope is string => typeof scope === "string"),
      };
    },
  };
}
