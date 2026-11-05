import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/config/env.js";

describe("env validation", () => {
  it("parses the test environment", () => {
    const parsed = parseEnv({ ...process.env, NODE_ENV: "test" });

    expect(parsed.NODE_ENV).toBe("test");
    expect(parsed.CORS_ORIGINS).toContain("http://localhost:3001");
    expect(parsed.ALLOWED_COUNTRY_CODES).toEqual(["977"]);
  });

  it("refuses OTP_DEV_BYPASS in production", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "production",
        GOOGLE_OAUTH_CLIENT_ID: "client",
        OTP_DEV_BYPASS: "123456",
      }),
    ).toThrow(/OTP_DEV_BYPASS must not be set in production/);
  });

  it("treats empty optional URLs as unset", () => {
    const parsed = parseEnv({
      ...process.env,
      NODE_ENV: "test",
      SMS_FALLBACK_URL: "",
      SMS_ALERT_WEBHOOK_URL: "",
    });

    expect(parsed.SMS_FALLBACK_URL).toBeUndefined();
    expect(parsed.SMS_ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it("requires sparrow credentials when selected", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "test",
        SMS_PROVIDER: "sparrow",
        SPARROW_TOKEN: "",
        SPARROW_FROM: "",
      }),
    ).toThrow(/SPARROW_TOKEN and SPARROW_FROM are required/);
  });

  it("requires Google client id in production", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "production",
        GOOGLE_OAUTH_CLIENT_ID: "",
      }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_ID is required in production/);
  });

  it("validates the admin IP allowlist as CIDRs", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "test",
        ADMIN_IP_ALLOWLIST: "203.0.113.0/24,2001:db8::/32",
      }),
    ).not.toThrow();
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "test",
        ADMIN_IP_ALLOWLIST: "not-a-cidr",
      }),
    ).toThrow(/Invalid CIDR/);
  });

  it("validates encryption key configuration", () => {
    const key = Buffer.alloc(32, 3).toString("base64");

    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "test",
        ENCRYPTION_KEYS: JSON.stringify({ v1: key }),
        ACTIVE_ENCRYPTION_KID: "v2",
      }),
    ).toThrow(/ACTIVE_ENCRYPTION_KID must exist/);
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "test",
        ENCRYPTION_KEYS: JSON.stringify({ v1: "short" }),
      }),
    ).toThrow(/32-byte key/);
  });

  it("requires a Resend API key when selected", () => {
    expect(() =>
      parseEnv({
        ...process.env,
        NODE_ENV: "test",
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "",
      }),
    ).toThrow(/RESEND_API_KEY is required/);
  });
});
