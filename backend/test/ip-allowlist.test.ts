import { describe, expect, it } from "vitest";
import { createIpAllowlist, ipInCidr } from "../src/lib/ip.js";

describe("IP allowlist", () => {
  it("allows everything when the list is empty", () => {
    const allow = createIpAllowlist([]);

    expect(allow("203.0.113.10")).toBe(true);
    expect(allow("::1")).toBe(true);
  });

  it("matches IPv4 and IPv6 CIDRs", () => {
    expect(ipInCidr("203.0.113.10", "203.0.113.0/24")).toBe(true);
    expect(ipInCidr("203.0.114.10", "203.0.113.0/24")).toBe(false);
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("203.0.113.10", "2001:db8::/32")).toBe(false);
  });

  it("rejects malformed addresses and ranges", () => {
    expect(ipInCidr("not-an-ip", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr("203.0.113.10", "203.0.113.0/99")).toBe(false);
    expect(ipInCidr("203.0.113.10", "203.0.113.10")).toBe(true);
  });

  it("requires an entry to match when the list is set", () => {
    const allow = createIpAllowlist(["198.51.100.0/24", "2001:db8::/32"]);

    expect(allow("198.51.100.7")).toBe(true);
    expect(allow("2001:db8::7")).toBe(true);
    expect(allow("203.0.113.7")).toBe(false);
  });
});
