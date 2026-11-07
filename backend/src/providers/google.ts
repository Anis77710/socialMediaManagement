import { OAuth2Client } from "google-auth-library";

export type GoogleIdentity = {
  sub: string;
  email?: string;
  name?: string;
};

export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export class GoogleVerifierUnavailableError extends Error {
  constructor() {
    super("Google sign-in is not configured");
    this.name = "GoogleVerifierUnavailableError";
  }
}

export class GoogleTokenError extends Error {
  constructor() {
    super("Invalid Google ID token");
    this.name = "GoogleTokenError";
  }
}

export function createGoogleVerifier(clientId: string | undefined): GoogleVerifier {
  if (!clientId) {
    return {
      async verify() {
        throw new GoogleVerifierUnavailableError();
      },
    };
  }

  const client = new OAuth2Client(clientId);

  return {
    async verify(idToken) {
      let payload;

      try {
        const ticket = await client.verifyIdToken({ idToken, audience: clientId });
        payload = ticket.getPayload();
      } catch {
        throw new GoogleTokenError();
      }

      if (!payload?.sub) {
        throw new GoogleTokenError();
      }

      return {
        sub: payload.sub,
        ...(payload.email && payload.email_verified ? { email: payload.email } : {}),
        ...(payload.name ? { name: payload.name } : {}),
      };
    },
  };
}
