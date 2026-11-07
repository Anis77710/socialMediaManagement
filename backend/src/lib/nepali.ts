import DateConverter from "@remotemerge/nepali-date-converter";
import { toDev } from "./money.js";

export const NPT_OFFSET_MINUTES = 5 * 60 + 45;
const NPT_OFFSET_MS = NPT_OFFSET_MINUTES * 60_000;

const BS_MONTHS_EN = [
  "Baishakh",
  "Jestha",
  "Ashadh",
  "Shrawan",
  "Bhadra",
  "Ashwin",
  "Kartik",
  "Mangsir",
  "Poush",
  "Magh",
  "Falgun",
  "Chaitra",
] as const;

const BS_MONTHS_NE = [
  "बैशाख",
  "जेठ",
  "असार",
  "साउन",
  "भदौ",
  "असोज",
  "कार्तिक",
  "मंसिर",
  "पुष",
  "माघ",
  "फाल्गुन",
  "चैत",
] as const;

export type BsDate = { year: number; month: number; day: number };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function nptParts(date: Date): { year: number; month: number; day: number } {
  const shifted = new Date(date.getTime() + NPT_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function nptDateString(date: Date): string {
  const parts = nptParts(date);

  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function startOfNptDay(date: Date): Date {
  const parts = nptParts(date);
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day);

  return new Date(utcMidnight - NPT_OFFSET_MS);
}

export function endOfNptDay(date: Date): Date {
  return new Date(startOfNptDay(date).getTime() + 86_400_000 - 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function toBs(date: Date): BsDate | null {
  try {
    const result = new DateConverter(nptDateString(date)).toBs();

    return { year: result.year, month: result.month, day: result.date };
  } catch {
    return null;
  }
}

export function fromBs(year: number, month: number, day: number): Date | null {
  try {
    const result = new DateConverter(`${year}-${pad(month)}-${pad(day)}`).toAd();

    return new Date(Date.UTC(result.year, result.month - 1, result.date) - NPT_OFFSET_MS);
  } catch {
    return null;
  }
}

export function formatBs(date: Date, lang: "NE" | "EN" = "NE"): string {
  const bs = toBs(date);

  if (!bs) {
    return lang === "NE" ? "मिति उपलब्ध छैन" : "Date unavailable";
  }

  if (lang === "NE") {
    return `${toDev(bs.day)} ${BS_MONTHS_NE[bs.month - 1] ?? ""}`;
  }

  return `${bs.day} ${BS_MONTHS_EN[bs.month - 1] ?? ""}`;
}

export function formatBsFull(date: Date, lang: "NE" | "EN" = "NE"): string {
  const bs = toBs(date);

  if (!bs) {
    return lang === "NE" ? "मिति उपलब्ध छैन" : "Date unavailable";
  }

  if (lang === "NE") {
    return `${BS_MONTHS_NE[bs.month - 1] ?? ""} ${toDev(bs.day)}, ${toDev(bs.year)}`;
  }

  return `${BS_MONTHS_EN[bs.month - 1] ?? ""} ${bs.day}, ${bs.year}`;
}

export function fiscalYear(date: Date): string {
  const bs = toBs(date);

  if (!bs) {
    return "UNKNOWN";
  }

  return bs.month >= 4 ? `${bs.year}-${bs.year + 1}` : `${bs.year - 1}-${bs.year}`;
}

export function daysBetween(from: Date, to: Date): number {
  const start = startOfNptDay(from).getTime();
  const end = startOfNptDay(to).getTime();

  return Math.round((end - start) / 86_400_000);
}

export function relativeDays(daysAway: number, lang: "NE" | "EN" = "EN"): string {
  if (daysAway <= 0) {
    return lang === "NE" ? "आज" : "today";
  }

  if (daysAway <= 7) {
    return lang === "NE" ? `${toDev(daysAway)} दिन` : `${daysAway} day${daysAway === 1 ? "" : "s"}`;
  }

  const weeks = Math.round(daysAway / 7);

  return lang === "NE" ? `${toDev(weeks)} हप्ता` : `${weeks} week${weeks === 1 ? "" : "s"}`;
}
