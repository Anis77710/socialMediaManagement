import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { loggerOptions } from "../src/config/logger.js";

describe("log redaction", () => {
  it("never writes phone numbers, OTP codes or tokens", () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ ...loggerOptions(env), level: "info" }, stream);

    logger.info(
      {
        body: {
          phone: "+9779812345678",
          code: "123456",
          idToken: "google-id-token",
          refreshToken: "refresh-token",
        },
        accessToken: "access-token",
        phoneE164: "+9779812345678",
        codeHash: "hash",
      },
      "redaction probe",
    );

    const output = chunks.join("");

    expect(output).not.toContain("+9779812345678");
    expect(output).not.toContain("123456");
    expect(output).not.toContain("google-id-token");
    expect(output).not.toContain("refresh-token");
    expect(output).not.toContain("access-token");
    expect(output).not.toContain('"hash"');
    expect(output).toContain("[REDACTED]");
  });
});
