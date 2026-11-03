import { describe, expect, it, vi } from "vitest";
import {
  createPasswordHasher,
  isPasswordPwned,
  sha1Hex,
} from "../src/lib/password.js";

const options = {
  memoryCost: 4096,
  timeCost: 1,
  parallelism: 1,
};

describe("staff password hashing", () => {
  it("hashes and verifies with argon2id", async () => {
    const hasher = createPasswordHasher(options);
    const encoded = await hasher.hash("Correct-Horse-Battery-9!");

    expect(encoded.startsWith("$argon2id$")).toBe(true);
    await expect(
      hasher.verify(encoded, "Correct-Horse-Battery-9!"),
    ).resolves.toBe(true);
    await expect(hasher.verify(encoded, "wrong-password")).resolves.toBe(false);
    expect(hasher.needsRehash(encoded)).toBe(false);
  });

  it("detects hashes that need rehashing", async () => {
    const hasher = createPasswordHasher(options);
    const encoded = await hasher.hash("Correct-Horse-Battery-9!");
    const stronger = createPasswordHasher({ ...options, timeCost: 2 });

    expect(stronger.needsRehash(encoded)).toBe(true);
    expect(hasher.needsRehash("not-a-hash")).toBe(true);
  });

  it("applies the pepper consistently", async () => {
    const peppered = createPasswordHasher({ ...options, pepper: "pepper-value" });
    const unpeppered = createPasswordHasher(options);
    const encoded = await peppered.hash("Correct-Horse-Battery-9!");

    await expect(
      peppered.verify(encoded, "Correct-Horse-Battery-9!"),
    ).resolves.toBe(true);
    await expect(
      unpeppered.verify(encoded, "Correct-Horse-Battery-9!"),
    ).resolves.toBe(false);
  });

  it("checks HIBP suffixes", async () => {
    const password = "hunter2-not-really";
    const digest = sha1Hex(password).toUpperCase();
    const suffix = digest.slice(5);
    const fetchImpl = vi.fn(async () => new Response(`${suffix}:12\r\n`));

    await expect(
      isPasswordPwned(password, { fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(digest.slice(0, 5)),
      expect.objectContaining({ headers: { "Add-Padding": "true" } }),
    );
  });

  it("fails open when HIBP is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      isPasswordPwned("password", {
        fetchImpl: fetchImpl as typeof fetch,
        log: { warn: vi.fn() },
      }),
    ).resolves.toBe(false);
  });
});
