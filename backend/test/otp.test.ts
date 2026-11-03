import { describe, expect, it } from "vitest";
import {
  OTP_LENGTH,
  buildOtpSmsText,
  generateOtpCode,
  hashOtpCode,
  otpCodeMatches,
} from "../src/lib/otp.js";

describe("otp", () => {
  it("generates six digit codes", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }

    expect(OTP_LENGTH).toBe(6);
  });

  it("hashes differently per challenge", () => {
    const pepper = "p".repeat(32);

    expect(hashOtpCode(pepper, "+9779812345678", "123456", "a")).not.toBe(
      hashOtpCode(pepper, "+9779812345678", "123456", "b"),
    );
    expect(hashOtpCode(pepper, "+9779812345678", "123456", "a")).toBe(
      hashOtpCode(pepper, "+9779812345678", "123456", "a"),
    );
  });

  it("compares codes in constant-time-safe form", () => {
    expect(otpCodeMatches("abcd", "abcd")).toBe(true);
    expect(otpCodeMatches("abcd", "abce")).toBe(false);
    expect(otpCodeMatches("abcd", "abcde")).toBe(false);
  });

  it("keeps the SMS ASCII and under 160 characters", () => {
    const text = buildOtpSmsText("123456");

    expect(text).toContain("Redflie code: 123456");
    expect(text.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7E\n]+$/.test(text)).toBe(true);
    expect(buildOtpSmsText("123456", "apphash").endsWith("apphash")).toBe(true);
  });
});
