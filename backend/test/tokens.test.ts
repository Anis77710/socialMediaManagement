import { describe, expect, it } from "vitest";
import { createTokenService, TokenError } from "../src/lib/tokens.js";

const service = createTokenService({
  privateKeyBase64: process.env.JWT_PRIVATE_KEY!,
  publicKeysBase64: JSON.parse(process.env.JWT_PUBLIC_KEYS!) as Record<string, string>,
  kid: process.env.JWT_KID!,
  accessTtlSec: 900,
});

describe("token service", () => {
  it("round-trips full access claims", async () => {
    const token = await service.signFull({
      userId: "user-1",
      sessionId: "session-1",
      tokenVersion: 3,
      scopes: ["user"],
    });

    await expect(service.verify(token)).resolves.toMatchObject({
      sub: "user-1",
      sid: "session-1",
      tv: 3,
      scp: ["user"],
    });
  });

  it("round-trips restricted Google claims", async () => {
    const token = await service.signRestricted({
      sub: "user-1",
      email: "a@example.com",
      name: "A",
    });

    const claims = await service.verifyRestricted(token);

    expect(claims.sub).toBe("google:user-1");
    expect(claims.gsub).toBe("user-1");
    expect(claims.scp).toEqual(["complete-profile"]);
    await expect(service.verify(token)).rejects.toBeInstanceOf(TokenError);
  });

  it("rejects tampered and unknown-kid tokens", async () => {
    const token = await service.signFull({
      userId: "user-1",
      sessionId: "session-1",
      tokenVersion: 0,
    });

    await expect(service.verify(`${token}x`)).rejects.toBeInstanceOf(TokenError);

    const other = createTokenService({
      privateKeyBase64: process.env.JWT_PRIVATE_KEY!,
      publicKeysBase64: JSON.parse(process.env.JWT_PUBLIC_KEYS!) as Record<string, string>,
      kid: "missing",
      accessTtlSec: 900,
    });

    await expect(service.verify(await other.signFull({
      userId: "user-1",
      sessionId: "session-1",
      tokenVersion: 0,
    }))).rejects.toBeInstanceOf(TokenError);
  });
});
