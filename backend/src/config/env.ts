import { BlockList, isIP } from "node:net";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

function isValidCidr(cidr: string): boolean {
  const [address, prefixPart] = cidr.split("/");
  const version = address ? isIP(address) : 0;

  if (version === 0) {
    return false;
  }

  const maxBits = version === 4 ? 32 : 128;
  const prefix = prefixPart === undefined ? maxBits : Number(prefixPart);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) {
    return false;
  }

  try {
    const block = new BlockList();
    block.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");

    return true;
  } catch {
    return false;
  }
}

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional(),
);

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );

const base64Pem = (label: string) =>
  z.string().refine(
    (value) => {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      return decoded.includes(`BEGIN ${label}`);
    },
    { message: `must be a base64-encoded PEM ${label}` },
  );

const jwtPublicKeys = z.string().refine(
  (value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        Object.values(parsed).every(
          (entry) =>
            typeof entry === "string" &&
            Buffer.from(entry, "base64").toString("utf8").includes("BEGIN PUBLIC KEY"),
        )
      );
    } catch {
      return false;
    }
  },
  { message: "must be a JSON object of kid -> base64-encoded PEM public key" },
);

const encryptionKeys = z.string().optional().refine(
  (value) => {
    if (value === undefined || value === "") {
      return true;
    }

    try {
      const parsed: unknown = JSON.parse(value);

      return (
        typeof parsed === "object" &&
        parsed !== null &&
        Object.values(parsed).every(
          (entry) => typeof entry === "string" && Buffer.from(entry, "base64").length === 32,
        )
      );
    } catch {
      return false;
    }
  },
  { message: "must be a JSON object of kid -> base64-encoded 32-byte key" },
);

const cidrList = z.string().default("").transform((value) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    TRUST_PROXY: booleanFromString,

    DATABASE_URL: z.url(),
    REDIS_URL: z.url().default("redis://localhost:6379"),

    JWT_PRIVATE_KEY: base64Pem("PRIVATE KEY"),
    JWT_PUBLIC_KEYS: jwtPublicKeys,
    JWT_KID: z.string().min(1),
    JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
    REFRESH_SLIDING_DAYS: z.coerce.number().int().positive().default(30),
    REFRESH_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(180),
    MAX_ACTIVE_SESSIONS: z.coerce.number().int().positive().max(50).default(10),

    OTP_PEPPER: z.string().min(32),
    OTP_TTL_SEC: z.coerce.number().int().positive().default(300),
    AUTH_TIMING_FLOOR_MS: z.coerce.number().int().min(0).max(2000).default(250),
    OTP_DEV_BYPASS: z
      .string()
      .regex(/^\d{6}$/, "must be exactly 6 digits")
      .optional(),

    SMS_PROVIDER: z.enum(["console", "fake", "sparrow", "secondary"]).default("console"),
    SPARROW_URL: z.url().default("https://api.sparrowsms.com/v2/sms/"),
    SPARROW_TOKEN: z.string().optional(),
    SPARROW_FROM: z.string().optional(),
    SMS_FALLBACK_URL: optionalUrl,
    SMS_FALLBACK_TOKEN: z.string().optional(),
    SMS_FALLBACK_FROM: z.string().optional(),
    SMS_DAILY_CAP: z.coerce.number().int().positive().default(1000),
    SMS_ALERT_WEBHOOK_URL: optionalUrl,
    ALLOWED_COUNTRY_CODES: csv("977"),

    TURNSTILE_SECRET: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    CORS_ORIGINS: csv("http://localhost:3001"),
    TERMS_VERSION: z.string().default("2026-01"),
    PRIVACY_VERSION: z.string().default("2026-01"),
    ANDROID_SMS_HASH: z.string().optional(),

    TOKEN_ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    }),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60_000),
    BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
    SWAGGER_ENABLED: booleanFromString,

    RUNTIME_ROLE: z.enum(["app-api", "admin-api"]).default("app-api"),
    ADMIN_WEB_URL: z.url().default("http://localhost:3001"),
    ADMIN_IP_ALLOWLIST: cidrList,
    ADMIN_SESSION_IDLE_MIN: z.coerce.number().int().positive().default(30),
    ADMIN_SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(8),
    ADMIN_MAX_SESSIONS: z.coerce.number().int().positive().max(10).default(3),
    ADMIN_SESSION_CACHE_SEC: z.coerce.number().int().min(0).default(30),
    ADMIN_STEP_UP_MIN: z.coerce.number().int().positive().default(10),
    ADMIN_MFA_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
    ADMIN_INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),
    ADMIN_RESET_TTL_MIN: z.coerce.number().int().positive().default(30),
    ADMIN_LOGIN_IP_LIMIT: z.coerce.number().int().positive().default(20),
    ADMIN_LOGIN_IP_WINDOW_MIN: z.coerce.number().int().positive().default(15),
    ADMIN_LOCKOUT_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),
    TOTP_ISSUER: z.string().default("Redflie Admin"),
    PASSWORD_PEPPER: z.string().min(32).optional(),
    HIBP_CHECK_ENABLED: booleanFromString,
    ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(65_536),
    ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
    ENCRYPTION_KEYS: encryptionKeys,
    ACTIVE_ENCRYPTION_KID: z.string().default("v1"),
    EMAIL_PROVIDER: z.enum(["console", "fake", "resend"]).default("console"),
    EMAIL_FROM: z.string().default("Redflie <no-reply@redflie.local>"),
    RESEND_API_KEY: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.OTP_DEV_BYPASS) {
      ctx.addIssue({
        code: "custom",
        path: ["OTP_DEV_BYPASS"],
        message: "OTP_DEV_BYPASS must not be set in production",
      });
    }

    if (value.SMS_PROVIDER === "sparrow" && (!value.SPARROW_TOKEN || !value.SPARROW_FROM)) {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER"],
        message: "SPARROW_TOKEN and SPARROW_FROM are required for the sparrow provider",
      });
    }

    if (
      value.SMS_PROVIDER === "secondary" &&
      (!value.SMS_FALLBACK_URL || !value.SMS_FALLBACK_TOKEN || !value.SMS_FALLBACK_FROM)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER"],
        message: "SMS_FALLBACK_URL, SMS_FALLBACK_TOKEN and SMS_FALLBACK_FROM are required",
      });
    }

    if (value.NODE_ENV === "production" && !value.GOOGLE_OAUTH_CLIENT_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_OAUTH_CLIENT_ID"],
        message: "GOOGLE_OAUTH_CLIENT_ID is required in production",
      });
    }

    for (const cidr of value.ADMIN_IP_ALLOWLIST) {
      if (!isValidCidr(cidr)) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_IP_ALLOWLIST"],
          message: `Invalid CIDR: ${cidr}`,
        });
      }
    }

    if (value.ENCRYPTION_KEYS) {
      const keys = JSON.parse(value.ENCRYPTION_KEYS) as Record<string, string>;

      if (!(value.ACTIVE_ENCRYPTION_KID in keys)) {
        ctx.addIssue({
          code: "custom",
          path: ["ACTIVE_ENCRYPTION_KID"],
          message: "ACTIVE_ENCRYPTION_KID must exist in ENCRYPTION_KEYS",
        });
      }
    }

    if (value.EMAIL_PROVIDER === "resend" && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required for the resend email provider",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${details}`);
  }

  return parsed.data;
}

export const env = Object.freeze(parseEnv());
