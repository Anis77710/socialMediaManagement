import { env } from "../src/config/env.js";
import { createTotpService } from "../src/lib/totp.js";

const secret = process.argv[2];

if (!secret) {
  console.error("Usage: npm run totp:code -- <BASE32_SECRET>");
  process.exit(1);
}

const totp = createTotpService({ issuer: env.TOTP_ISSUER });

try {
  console.log(await totp.code(secret));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
