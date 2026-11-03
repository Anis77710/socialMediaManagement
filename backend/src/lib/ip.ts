import { BlockList, isIP } from "node:net";

export function ipInCidr(ip: string, cidr: string): boolean {
  const version = isIP(ip);

  if (version === 0) {
    return false;
  }

  const [range, bitsPart] = cidr.split("/");
  const rangeVersion = range ? isIP(range) : 0;

  if (rangeVersion === 0 || rangeVersion !== version) {
    return false;
  }

  const maxBits = version === 4 ? 32 : 128;
  const bits = bitsPart === undefined ? maxBits : Number(bitsPart);

  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
    return false;
  }

  try {
    const block = new BlockList();
    block.addSubnet(range, bits, version === 4 ? "ipv4" : "ipv6");

    return block.check(ip, version === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

export function createIpAllowlist(cidrs: string[]): (ip: string) => boolean {
  if (cidrs.length === 0) {
    return () => true;
  }

  return (ip) => cidrs.some((cidr) => ipInCidr(ip, cidr));
}
