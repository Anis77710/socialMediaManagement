import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskIp, maskPhone, normalizePhone } from "../src/lib/phone.js";

describe("normalizePhone", () => {
  it.each([
    ["+977 9812345678", "+9779812345678"],
    ["00977 9812345678", "+9779812345678"],
    ["9779812345678", "+9779812345678"],
    ["9812345678", "+9779812345678"],
    ["98-1234-5678", "+9779812345678"],
    ["(96) 1234 5678", "+9779612345678"],
    ["9712345678", "+9779712345678"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    "",
    "hello",
    "919876543210",
    "+977 919876543210",
    "9779912345678",
    "9779512345678",
    "981234567",
    "98123456789",
    "+1 555 123 4567",
  ])("rejects %s", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("only accepts allowed country codes", () => {
    expect(normalizePhone("+9779812345678", ["91"])).toBeNull();
  });

  it("canonical national numbers are always stable", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("96", "97", "98"),
        fc.stringMatching(/^\d{8}$/),
        (prefix, tail) => {
          const national = `${prefix}${tail}`;

          expect(normalizePhone(national)).toBe(`+977${national}`);
          expect(normalizePhone(`+977${national}`)).toBe(`+977${national}`);
          expect(normalizePhone(`00977${national}`)).toBe(`+977${national}`);
        },
      ),
    );
  });

  it("rejects numeric strings outside the mobile prefixes", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{10}$/), (digits) => {
        const firstTwo = digits.slice(0, 2);

        if (["96", "97", "98"].includes(firstTwo)) {
          return;
        }

        expect(normalizePhone(digits)).toBeNull();
      }),
    );
  });
});

describe("maskPhone", () => {
  it("keeps the country code and last two digits only", () => {
    expect(maskPhone("+9779812345678")).toBe("+97798******78");
  });
});

describe("maskIp", () => {
  it("masks IPv4 and IPv6 addresses", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.113.x");
    expect(maskIp("2001:db8:85a3::8a2e")).toBe("2001:db8:*");
    expect(maskIp(undefined)).toBeNull();
  });
});
