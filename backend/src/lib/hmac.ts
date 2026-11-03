import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(key: string, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function safeEqualHex(left: string, right: string): boolean {
  if (
    left.length % 2 !== 0 ||
    right.length % 2 !== 0 ||
    !/^[0-9a-f]*$/i.test(left) ||
    !/^[0-9a-f]*$/i.test(right)
  ) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
