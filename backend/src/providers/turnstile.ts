export interface CaptchaVerifier {
  verify(token: string, ip?: string): Promise<boolean>;
}

const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileVerifier(secret: string | undefined): CaptchaVerifier {
  return {
    async verify(token, ip) {
      if (!secret) {
        return false;
      }

      const body = new URLSearchParams({ secret, response: token });

      if (ip) {
        body.set("remoteip", ip);
      }

      try {
        const response = await fetch(verifyUrl, {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          signal: AbortSignal.timeout(5000),
        });
        const result = (await response.json()) as { success?: boolean };

        return result.success === true;
      } catch {
        return false;
      }
    },
  };
}
