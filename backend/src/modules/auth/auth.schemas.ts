import { z } from "zod";

export const phoneInputSchema = z.string().trim().min(1).max(32);
export const otpCodeSchema = z.string().regex(/^\d{6}$/, "must be a 6-digit code");
export const challengeIdSchema = z.string().min(1).max(64);

export const consentSchema = z.object({
  termsVersion: z.string().min(1).max(50),
  privacyVersion: z.string().min(1).max(50),
});

export const deviceSchema = z.object({
  platform: z.enum(["ANDROID", "IOS", "WEB"]).optional(),
  name: z.string().trim().min(1).max(100).optional(),
});

export const authUserSchema = z.object({
  id: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  locale: z.enum(["NE", "EN"]),
  status: z.string(),
  hasGoogle: z.boolean(),
});

export const requestOtpSchema = z.object({
  phone: phoneInputSchema,
  captchaToken: z.string().min(1).optional(),
});

export const verifyOtpSchema = z.object({
  challengeId: challengeIdSchema,
  code: otpCodeSchema,
  consent: consentSchema,
  device: deviceSchema.optional(),
});

export const googleLoginSchema = z.object({
  idToken: z.string().min(1),
  consent: consentSchema,
  device: deviceSchema.optional(),
});

export const refreshBodySchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .optional();

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(["NE", "EN"]).optional(),
  })
  .refine((value) => value.name !== undefined || value.locale !== undefined, {
    message: "Provide at least one field",
  });

export const phoneChangeRequestSchema = z.object({
  newPhone: phoneInputSchema,
  captchaToken: z.string().min(1).optional(),
});

export const phoneChangeConfirmSchema = z.object({
  challengeId: challengeIdSchema,
  code: otpCodeSchema,
});

export const googleLinkSchema = z.object({
  idToken: z.string().min(1),
});

export const challengeResponseSchema = z.object({
  challengeId: z.string(),
  resendAfterSec: z.number().int().positive(),
  expiresInSec: z.number().int().positive(),
});

export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().int().positive(),
  user: authUserSchema,
  isNewUser: z.boolean(),
  deletionPending: z.boolean(),
});

export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().int().positive(),
});

export const googleResponseSchema = z.union([
  sessionResponseSchema,
  z.object({
    needsPhone: z.literal(true),
    restrictedToken: z.string(),
    expiresIn: z.number().int().positive(),
  }),
]);

export const sessionViewSchema = z.object({
  id: z.string(),
  deviceName: z.string().nullable(),
  platform: z.string().nullable(),
  lastUsedAt: z.date().nullable(),
  ipMasked: z.string().nullable(),
  current: z.boolean(),
});

export const configResponseSchema = z.object({
  termsVersion: z.string(),
  privacyVersion: z.string(),
  captchaRequired: z.boolean(),
  otpLength: z.number().int().positive(),
  otpTtlSec: z.number().int().positive(),
});
