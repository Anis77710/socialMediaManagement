import { z } from "zod";

export const phoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^[+0-9\s-]+$/, "Phone may contain digits, spaces, dashes and a leading +");

export const optionalPhoneSchema = phoneSchema.optional();

export const languageSchema = z.enum(["NE", "EN"]);

export const platformSchema = z.enum([
  "FACEBOOK",
  "INSTAGRAM",
  "TIKTOK",
  "GOOGLE_BUSINESS",
]);

export const autonomyModeSchema = z.enum(["MANUAL", "APPROVAL", "AUTOPILOT"]);

export const idSchema = z.string().trim().min(1).max(64);

export const dateTimeSchema = z.coerce.date();

export const urlSchema = z
  .url()
  .refine((value) => value.length <= 2048, "URL must be at most 2048 characters");

export const moneySchema = z
  .object({
    amountPaisa: z.number().int().nonnegative(),
    currency: z.literal("NPR").default("NPR"),
  })
  .strict();

export const cursorQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export function acceptLanguage(header: string | undefined): "NE" | "EN" {
  if (!header) {
    return "NE";
  }

  return header.toLowerCase().startsWith("en") ? "EN" : "NE";
}
