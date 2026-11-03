import { randomInt } from "node:crypto";
import { hmacHex, safeEqualHex } from "./hmac.js";

export const OTP_LENGTH = 6;
export const OTP_TTL_SEC = 300;

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000)
    .toString()
    .padStart(OTP_LENGTH, "0");
}

export function hashOtpCode(
  pepper: string,
  phoneE164: string,
  code: string,
  challengeId: string,
): string {
  return hmacHex(pepper, `${phoneE164}:${code}:${challengeId}`);
}

export function otpCodeMatches(expectedHash: string, candidateHash: string): boolean {
  return safeEqualHex(expectedHash, candidateHash);
}

export function buildOtpSmsText(code: string, androidSmsHash?: string): string {
  const text = `Redflie code: ${code}. Valid for 5 minutes. Never share it.`;

  return androidSmsHash ? `${text}\n\n${androidSmsHash}` : text;
}
