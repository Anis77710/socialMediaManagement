import { describe, expect, it } from "vitest";
import {
  CURRENCY,
  assertPaisa,
  formatNpr,
  fromDev,
  groupIndianDigits,
  paisaToRupees,
  percentOf,
  rupeesToPaisa,
  toDev,
  vatFromNet,
  vatIncludedInGross,
} from "../src/lib/money.js";
import {
  addDays,
  daysBetween,
  endOfNptDay,
  fiscalYear,
  formatBs,
  formatBsFull,
  fromBs,
  nptDateString,
  nptParts,
  relativeDays,
  startOfNptDay,
  toBs,
} from "../src/lib/nepali.js";
import {
  allowedDigitRuns,
  containsReplacementCharacter,
  contentHash,
  devanagariRatio,
  extractFacts,
  validateNumericGuard,
} from "../src/modules/creatives/facts.js";
import { hashRequest, requireIdempotencyKey } from "../src/lib/idempotency.js";
import { decodeCursor, encodeCursor, pageResult } from "../src/lib/cursor.js";

describe("money", () => {
  it("converts digits to and from Devanagari", () => {
    expect(toDev("0123456789")).toBe("०१२३४५६७८९");
    expect(fromDev("०१२३४५६७८९")).toBe("0123456789");
    expect(toDev(2082)).toBe("२०८२");
  });

  it("groups digits using the Indian numbering system", () => {
    expect(groupIndianDigits("123")).toBe("123");
    expect(groupIndianDigits("1234")).toBe("1,234");
    expect(groupIndianDigits("123456789")).toBe("12,34,56,789");
  });

  it("formats NPR in English and Nepali", () => {
    expect(CURRENCY).toBe("NPR");
    expect(formatNpr(12345678)).toBe("Rs. 1,23,456.78");
    expect(formatNpr(12345600)).toBe("Rs. 1,23,456");
    expect(formatNpr(12345600, "NE")).toBe("रु. १,२३,४५६");
    expect(formatNpr(105, "NE")).toBe("रु. १.०५");
  });

  it("validates and converts paisa amounts", () => {
    expect(assertPaisa(100)).toBe(100);
    expect(rupeesToPaisa(12.345)).toBe(1235);
    expect(paisaToRupees(1235)).toBe(12.35);
    expect(() => assertPaisa(-1)).toThrow();
    expect(() => assertPaisa(1.5)).toThrow();
    expect(() => rupeesToPaisa(Number.NaN)).toThrow();
  });

  it("calculates percentages and VAT", () => {
    expect(percentOf(10_000, 1300)).toBe(1300);
    expect(vatFromNet(10_000, 1300)).toBe(1300);
    expect(vatIncludedInGross(11_300, 1300)).toBe(1300);
    expect(vatIncludedInGross(11_300, 0)).toBe(0);
  });
});

describe("nepali dates", () => {
  it("uses the +05:45 offset for NPT", () => {
    expect(nptParts(new Date("2026-01-01T00:00:00.000Z"))).toEqual({
      year: 2026,
      month: 1,
      day: 1,
    });
    expect(nptDateString(new Date("2025-12-31T18:14:59.999Z"))).toBe("2025-12-31");
    expect(nptDateString(new Date("2025-12-31T18:15:00.000Z"))).toBe("2026-01-01");
    expect(startOfNptDay(new Date("2026-01-01T10:00:00.000Z")).toISOString()).toBe(
      "2025-12-31T18:15:00.000Z",
    );
    expect(endOfNptDay(new Date("2026-01-01T10:00:00.000Z")).toISOString()).toBe(
      "2026-01-01T18:14:59.999Z",
    );
  });

  it("converts AD dates to BS and back", () => {
    expect(toBs(new Date("2026-01-01T06:00:00.000Z"))).toEqual({
      year: 2082,
      month: 9,
      day: 17,
    });
    expect(formatBs(new Date("2026-01-01T06:00:00.000Z"), "EN")).toBe("17 Poush");
    expect(formatBsFull(new Date("2026-01-01T06:00:00.000Z"), "EN")).toBe(
      "Poush 17, 2082",
    );
    expect(fromBs(2082, 9, 17)?.toISOString()).toBe("2025-12-31T18:15:00.000Z");
    expect(fromBs(2082, 13, 1)).toBeNull();
  });

  it("derives fiscal year, day counts and relative labels", () => {
    expect(fiscalYear(new Date("2026-01-01T06:00:00.000Z"))).toBe("2082-2083");
    expect(fiscalYear(new Date("2026-08-01T06:00:00.000Z"))).toBe("2083-2084");
    expect(daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-03T00:00:00Z"))).toBe(
      2,
    );
    expect(addDays(new Date("2026-01-01T00:00:00Z"), 2).toISOString()).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    expect(relativeDays(0)).toBe("today");
    expect(relativeDays(1)).toBe("1 day");
    expect(relativeDays(2)).toBe("2 days");
    expect(relativeDays(14)).toBe("2 weeks");
  });
});

describe("creative facts", () => {
  it("extracts percentages, prices and phone numbers", () => {
    const { facts, issues } = extractFacts(
      "50% off all items. Rs. 1,200 only. Call 9801234567.",
    );

    expect(issues).toEqual([]);
    expect(facts.percent).toBe(50);
    expect(facts.prices).toEqual([1200]);
    expect(facts.phones).toEqual(["9801234567"]);
    expect(facts.primary).toEqual({ text: "50%", unit: "off" });
    expect(facts.hasOfferFacts).toBe(true);
  });

  it("handles Nepali currency, Devanagari digits and starting-from copy", () => {
    const { facts } = extractFacts("देखि रु. ५०० मा उपलब्ध");

    expect(facts.prices).toEqual([500]);
    expect(facts.isFrom).toBe(true);
    expect(facts.primary).toEqual({ text: "500", unit: "from" });
  });

  it("reports conflicting and out-of-range facts", () => {
    expect(extractFacts("10% off and 20% off").issues.map((issue) => issue.code)).toContain(
      "FACT_CONFLICT",
    );
    expect(extractFacts("99% off").issues.map((issue) => issue.code)).toContain(
      "FACT_OUT_OF_RANGE",
    );
    expect(extractFacts("Rs. 0").issues.map((issue) => issue.code)).toContain(
      "FACT_OUT_OF_RANGE",
    );
    expect(
      extractFacts("Rs. 100, Rs. 200, Rs. 300, Rs. 400").issues.map((issue) => issue.code),
    ).toContain("FACT_CONFLICT");
  });

  it("guards generated copy against invented numbers", () => {
    const { facts } = extractFacts("50% off. Rs. 1200. Call 9801234567.");
    const allowed = allowedDigitRuns(facts);

    expect(allowed.has("50")).toBe(true);
    expect(allowed.has("1200")).toBe(true);
    expect(validateNumericGuard("50% off at Rs. 1200", facts)).toEqual({
      ok: true,
      offending: [],
    });
    expect(validateNumericGuard("50% off at Rs. 1300", facts).offending).toEqual(["1300"]);
    expect(validateNumericGuard("Call 9801234567", facts, ["9801234567"]).ok).toBe(true);
  });

  it("measures Devanagari content and replacement characters", () => {
    expect(devanagariRatio("नेपाली")).toBe(1);
    expect(devanagariRatio("hello")).toBe(0);
    expect(devanagariRatio("hello नेपाली")).toBeGreaterThan(0);
    expect(containsReplacementCharacter("ok")).toBe(false);
    expect(containsReplacementCharacter("bad \uFFFD")).toBe(true);
  });

  it("hashes creative content deterministically", () => {
    const { facts } = extractFacts("50% off");
    const input = {
      templateKey: "offer",
      texts: { headline: "50% off" },
      facts,
      inverted: false,
    };

    expect(contentHash(input)).toBe(contentHash({ ...input, texts: { ...input.texts } }));
    expect(contentHash(input)).not.toBe(contentHash({ ...input, inverted: true }));
  });
});

describe("request helpers", () => {
  it("requires strong idempotency keys and hashes bodies", () => {
    expect(requireIdempotencyKey("abcdefgh")).toBe("abcdefgh");
    expect(() => requireIdempotencyKey(undefined)).toThrow();
    expect(() => requireIdempotencyKey("short")).toThrow();
    expect(hashRequest({ a: 1 })).toBe(hashRequest({ a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it("round-trips keyset cursors and pages rows", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const cursor = encodeCursor(createdAt, "abc");

    expect(decodeCursor(cursor)).toEqual({
      createdAt: createdAt.toISOString(),
      id: "abc",
    });
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor("not-a-cursor")).toThrow();

    const rows = [
      { id: "c", createdAt },
      { id: "b", createdAt },
      { id: "a", createdAt },
    ];
    const page = pageResult(rows, 2);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(pageResult(rows.slice(0, 2), 2).nextCursor).toBeNull();
  });
});
