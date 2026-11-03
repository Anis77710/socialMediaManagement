import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

process.env.JWT_PRIVATE_KEY = Buffer.from(privatePem).toString("base64");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({
  test: Buffer.from(publicPem).toString("base64"),
});
process.env.JWT_KID = "test";
process.env.OTP_PEPPER = "test-otp-pepper-at-least-thirty-two-characters";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.SMS_PROVIDER = "fake";
process.env.AUTH_TIMING_FLOOR_MS = "0";
process.env.CORS_ORIGINS = "http://localhost:3001";
process.env.TERMS_VERSION = "test-terms";
process.env.PRIVACY_VERSION = "test-privacy";
process.env.SWAGGER_ENABLED = "false";
process.env.ALLOWED_COUNTRY_CODES = "977";
process.env.RUNTIME_ROLE = "app-api";
process.env.ADMIN_WEB_URL = "http://localhost:3001";
process.env.ADMIN_IP_ALLOWLIST = "";
process.env.EMAIL_PROVIDER = "fake";
process.env.HIBP_CHECK_ENABLED = "false";
process.env.ARGON2_MEMORY_KIB = "4096";
process.env.ARGON2_TIME_COST = "1";
process.env.ARGON2_PARALLELISM = "1";
delete process.env.OTP_DEV_BYPASS;
delete process.env.PASSWORD_PEPPER;
delete process.env.ENCRYPTION_KEYS;
