import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors.js";

const BLOCKED_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.168\./,
  /^198\.(18|19)\./,
  /^22[4-9]\./,
  /^2[3-5]\d\./,
];

function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return BLOCKED_V4.some((pattern) => pattern.test(address));
  }

  const normalized = address.toLowerCase();

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

export async function assertSafeRemoteUrl(raw: string): Promise<URL> {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, "INVALID_URL", "The URL is invalid");
  }

  if (url.protocol !== "https:") {
    throw new AppError(400, "INVALID_URL", "Only HTTPS URLs are allowed");
  }

  const host = url.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new AppError(400, "INVALID_URL", "This host is not allowed");
  }

  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new AppError(400, "INVALID_URL", "Private network addresses are not allowed");
    }

    return url;
  }

  const addresses = await lookup(host, { all: true });

  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new AppError(400, "INVALID_URL", "The URL resolves to a private network address");
  }

  return url;
}

export async function fetchWithLimits(
  raw: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const url = await assertSafeRemoteUrl(raw);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      signal: controller.signal,
      redirect: "manual",
    });
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    if (reader) {
      for (;;) {
        const result = (await reader.read()) as {
          done: boolean;
          value?: Uint8Array;
        };
        const value = result.value;

        if (result.done || !value) {
          break;
        }

        total += value.byteLength;

        if (total > maxBytes) {
          controller.abort();
          throw new AppError(400, "RESPONSE_TOO_LARGE", "The remote response is too large");
        }

        chunks.push(value);
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    };
  } finally {
    clearTimeout(timeout);
  }
}
