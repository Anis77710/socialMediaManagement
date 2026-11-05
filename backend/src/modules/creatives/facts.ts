import { createHash } from "node:crypto";
import { fromDev, toDev } from "../../lib/money.js";

export type ExtractedFacts = {
  percent?: number;
  prices: number[];
  isFrom: boolean;
  phones: string[];
  primary: { text: string; unit: string } | null;
  hasOfferFacts: boolean;
};

export type FactIssue = {
  code: "FACT_CONFLICT" | "FACT_OUT_OF_RANGE";
  message: string;
  value: string;
};

const PERCENT_PATTERN = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|प्रतिशत)/gi;
const PRICE_AFTER_PATTERN = /(?:rs\.?|npr|रु\.?|रू\.?)\s*([\d,]+(?:\.\d+)?)/gi;
const PRICE_BEFORE_PATTERN = /([\d,]+(?:\.\d+)?)\s*(?:रुपैयाँ|रुपया|rupees?)/gi;
const PHONE_PATTERN = /(?:\+?977[\s-]?)?((?:96|97|98)\d{8})/g;
const FROM_PATTERN = /\b(?:starting|starts?|from)\b|देखि/iu;

const MAX_PRICE_NPR = 10_000_000;
const MAX_PERCENT = 95;

function normalize(raw: string): string {
  return raw.normalize("NFC").trim();
}

function parseNumber(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));

  return Number.isFinite(parsed) ? parsed : null;
}

export function extractFacts(raw: string): { facts: ExtractedFacts; issues: FactIssue[] } {
  const normalized = normalize(raw);
  const parseCopy = fromDev(normalized);
  const issues: FactIssue[] = [];
  const percents = new Set<number>();
  const prices = new Set<number>();
  const phones = new Set<string>();

  for (const match of parseCopy.matchAll(PERCENT_PATTERN)) {
    const value = parseNumber(match[1] ?? "");

    if (value === null) {
      continue;
    }

    if (value < 1 || value > MAX_PERCENT) {
      issues.push({
        code: "FACT_OUT_OF_RANGE",
        message: `Discount percentage must be between 1 and ${MAX_PERCENT}`,
        value: match[0],
      });
      continue;
    }

    percents.add(value);
  }

  for (const match of parseCopy.matchAll(PRICE_AFTER_PATTERN)) {
    const value = parseNumber(match[1] ?? "");

    if (value !== null) {
      prices.add(value);
    }
  }

  for (const match of parseCopy.matchAll(PRICE_BEFORE_PATTERN)) {
    const value = parseNumber(match[1] ?? "");

    if (value !== null) {
      prices.add(value);
    }
  }

  for (const value of prices) {
    if (value <= 0 || value > MAX_PRICE_NPR) {
      issues.push({
        code: "FACT_OUT_OF_RANGE",
        message: `Price must be between 1 and ${MAX_PRICE_NPR} NPR`,
        value: String(value),
      });
    }
  }

  for (const match of parseCopy.matchAll(PHONE_PATTERN)) {
    const national = match[1];

    if (national) {
      phones.add(national);
    }
  }

  if (percents.size > 1) {
    issues.push({
      code: "FACT_CONFLICT",
      message: "The brief contains more than one discount percentage",
      value: [...percents].join(", "),
    });
  }

  if (prices.size > 3) {
    issues.push({
      code: "FACT_CONFLICT",
      message: "The brief contains too many different prices",
      value: [...prices].join(", "),
    });
  }

  const percent = [...percents][0];
  const priceList = [...prices];
  const isFrom = FROM_PATTERN.test(parseCopy);
  const primary =
    percent !== undefined
      ? { text: `${percent}%`, unit: "off" }
      : priceList[0] !== undefined
        ? { text: String(priceList[0]), unit: isFrom ? "from" : "NPR" }
        : null;

  return {
    facts: {
      ...(percent !== undefined ? { percent } : {}),
      prices: priceList,
      isFrom,
      phones: [...phones],
      primary,
      hasOfferFacts: percent !== undefined || priceList.length > 0,
    },
    issues,
  };
}

export function allowedDigitRuns(facts: ExtractedFacts, extraPhones: string[] = []): Set<string> {
  const allowed = new Set<string>();

  if (facts.percent !== undefined) {
    allowed.add(String(facts.percent));
    allowed.add(toDev(String(facts.percent)));
  }

  for (const price of facts.prices) {
    allowed.add(String(price));
    allowed.add(toDev(String(price)));
  }

  for (const phone of [...facts.phones, ...extraPhones]) {
    allowed.add(phone);
    allowed.add(phone.replace(/^\+977/, ""));
    allowed.add(toDev(phone));
    allowed.add(toDev(phone.replace(/^\+977/, "")));
  }

  return allowed;
}

export function validateNumericGuard(
  text: string,
  facts: ExtractedFacts,
  extraPhones: string[] = [],
): { ok: boolean; offending: string[] } {
  const allowed = allowedDigitRuns(facts, extraPhones);
  const runs = text.normalize("NFC").match(/\d+/g) ?? [];
  const offending = runs.filter((run) => !allowed.has(run));

  return { ok: offending.length === 0, offending };
}

export function devanagariRatio(text: string): number {
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, " ");
  const letters = withoutUrls.match(/\p{L}/gu) ?? [];

  if (letters.length === 0) {
    return 1;
  }

  const devanagari = letters.filter((letter) => /[\u0900-\u097F]/u.test(letter)).length;

  return devanagari / letters.length;
}

export function containsReplacementCharacter(text: string): boolean {
  return text.includes("\uFFFD");
}

export function contentHash(input: {
  templateKey: string;
  templateVersion?: number;
  texts: Record<string, string | null | undefined>;
  facts: ExtractedFacts;
  inverted: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        templateKey: input.templateKey,
        templateVersion: input.templateVersion ?? 1,
        texts: input.texts,
        facts: input.facts,
        inverted: input.inverted,
      }),
    )
    .digest("hex");
}

