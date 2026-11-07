import type { Env } from "./env.js";

export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "phone",
  "phoneE164",
  "code",
  "codeHash",
  "otp",
  "otpCode",
  "accessToken",
  "refreshToken",
  "idToken",
  "body.phone",
  "body.phoneE164",
  "body.code",
  "body.idToken",
  "body.refreshToken",
  "body.captchaToken",
  "*.phone",
  "*.phoneE164",
  "*.codeHash",
  "*.otp",
  "*.otpCode",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
];

export function loggerOptions(env: Env) {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              ignore: "pid,hostname",
              translateTime: "SYS:standard",
            },
          },
        }
      : {}),
  };
}
