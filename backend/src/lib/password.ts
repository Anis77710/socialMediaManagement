import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Algorithm } from "@node-rs/argon2";
import { hash as argon2Hash, parseOptions, verify as argon2Verify } from "@node-rs/argon2";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { adjacencyGraphs, dictionary as commonDictionary } from "@zxcvbn-ts/language-common";
import { dictionary as enDictionary, translations } from "@zxcvbn-ts/language-en";

const zxcvbn = new ZxcvbnFactory({
  dictionary: { ...commonDictionary, ...enDictionary },
  graphs: adjacencyGraphs,
  translations,
});

export type PasswordPolicyConfig = {
  minLength: number;
  maxLength: number;
  minScore: number;
};

export const defaultPasswordPolicy: PasswordPolicyConfig = {
  minLength: 12,
  maxLength: 128,
  minScore: 3,
};

export type PasswordPolicyResult =
  | { ok: true; score: number }
  | { ok: false; score: number; reasons: string[] };

export function evaluatePasswordPolicy(
  password: string,
  userInputs: string[] = [],
  policy: PasswordPolicyConfig = defaultPasswordPolicy,
): PasswordPolicyResult {
  const reasons: string[] = [];

  if (password.length < policy.minLength) {
    reasons.push(`Password must be at least ${policy.minLength} characters`);
  }

  if (password.length > policy.maxLength) {
    reasons.push(`Password must be at most ${policy.maxLength} characters`);
  }

  const lower = password.toLowerCase();
  const tokens = userInputs
    .flatMap((input) => [input, ...input.split(/[\s@._-]+/)])
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3);

  if (tokens.some((token) => lower.includes(token))) {
    reasons.push("Password must not contain your name or email address");
  }

  const result = zxcvbn.check(password, userInputs);

  if (result.score < policy.minScore) {
    reasons.push("Password is too easy to guess");
  }

  return reasons.length === 0
    ? { ok: true, score: result.score }
    : { ok: false, score: result.score, reasons };
}

export type PasswordHasherConfig = {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  pepper?: string;
};

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(encoded: string, password: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
  dummyVerify(password: string): Promise<void>;
};

function peppered(password: string, pepper: string | undefined): string {
  if (!pepper) {
    return password;
  }

  return createHmac("sha256", pepper).update(password, "utf8").digest("hex");
}

const argon2id = 2 as Algorithm;

export function createPasswordHasher(config: PasswordHasherConfig): PasswordHasher {
  const options = {
    algorithm: argon2id,
    memoryCost: config.memoryCost,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
  };

  let dummyHash: Promise<string> | null = null;

  return {
    hash(password) {
      return argon2Hash(peppered(password, config.pepper), options);
    },

    verify(encoded, password) {
      return argon2Verify(encoded, peppered(password, config.pepper), options);
    },

    needsRehash(encoded) {
      try {
        const parsed = parseOptions(encoded);

        return (
          parsed.algorithm !== argon2id ||
          parsed.memoryCost !== config.memoryCost ||
          parsed.timeCost !== config.timeCost ||
          parsed.parallelism !== config.parallelism
        );
      } catch {
        return true;
      }
    },

    async dummyVerify(password) {
      dummyHash ??= argon2Hash(randomBytes(16).toString("hex"), options);
      await argon2Verify(await dummyHash, peppered(password, config.pepper), options);
    },
  };
}

export type HIBPCheckOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: { warn(object: Record<string, unknown>, message: string): void };
};

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

export async function isPasswordPwned(
  password: string,
  options: HIBPCheckOptions = {},
): Promise<boolean> {
  const digest = sha1Hex(password).toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });

    if (!response.ok) {
      return false;
    }

    const body = await response.text();

    return body
      .split("\n")
      .some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
  } catch (error) {
    options.log?.warn({ error }, "HIBP lookup failed; allowing password");

    return false;
  }
}
