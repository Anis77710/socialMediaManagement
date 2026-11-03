import { generate, generateSecret as otpGenerateSecret, generateURI, verify } from "otplib";

export type TotpConfig = {
  issuer: string;
  periodSec?: number;
  digits?: 6 | 8;
  toleranceSec?: number;
  now?: () => Date;
};

export type TotpVerification =
  | { valid: true; step: bigint }
  | { valid: false };

export type TotpService = {
  generateSecret(): string;
  uri(label: string, secret: string): string;
  code(secret: string, at?: Date): Promise<string>;
  verify(input: {
    secret: string;
    token: string;
    lastStep: bigint | null;
    at?: Date;
  }): Promise<TotpVerification>;
};

export function createTotpService(config: TotpConfig): TotpService {
  const period = config.periodSec ?? 30;
  const digits = config.digits ?? 6;
  const tolerance = config.toleranceSec ?? 30;
  const now = config.now ?? (() => new Date());

  function epoch(at: Date): number {
    return Math.floor(at.getTime() / 1000);
  }

  return {
    generateSecret() {
      return otpGenerateSecret();
    },

    uri(label, secret) {
      return generateURI({
        issuer: config.issuer,
        label,
        secret,
        period,
        digits,
      });
    },

    code(secret, at = now()) {
      return generate({ secret, epoch: epoch(at), period, digits });
    },

    async verify({ secret, token, lastStep, at = now() }) {
      const result = await verify({
        secret,
        token,
        epoch: epoch(at),
        period,
        digits,
        epochTolerance: tolerance,
        ...(lastStep === null ? {} : { afterTimeStep: Number(lastStep) }),
      });

      if (!result.valid || !("epoch" in result)) {
        return { valid: false };
      }

      return { valid: true, step: BigInt(Math.floor(result.epoch / period)) };
    },
  };
}
