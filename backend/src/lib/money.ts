import { AppError } from "./errors.js";

export const CURRENCY = "NPR" as const;

const DEVANAGARI_DIGITS = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"] as const;
const ASCII_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function toDev(input: string | number): string {
  return String(input).replace(/\d/g, (digit) => DEVANAGARI_DIGITS[Number(digit)] ?? digit);
}

export function fromDev(input: string): string {
  return input.replace(/[०-९]/g, (digit) => {
    const index = DEVANAGARI_DIGITS.indexOf(digit as (typeof DEVANAGARI_DIGITS)[number]);

    return index >= 0 ? (ASCII_DIGITS[index] ?? digit) : digit;
  });
}

export function assertPaisa(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(400, "INVALID_AMOUNT", "Amount must be a non-negative integer in paisa");
  }

  return value;
}

export function rupeesToPaisa(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0) {
    throw new AppError(400, "INVALID_AMOUNT", "Amount must be a non-negative number");
  }

  return Math.round(rupees * 100);
}

export function paisaToRupees(paisa: number): number {
  assertPaisa(paisa);

  return paisa / 100;
}

export function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }

  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");

  return `${grouped},${lastThree}`;
}

export function formatNpr(paisa: number, lang: "NE" | "EN" = "EN"): string {
  assertPaisa(paisa);
  const rupees = Math.floor(paisa / 100);
  const paise = paisa % 100;
  const digits = groupIndianDigits(String(rupees));
  const decimal = paise === 0 ? "" : `.${String(paise).padStart(2, "0")}`;

  if (lang === "NE") {
    return `रु. ${toDev(`${digits}${decimal}`)}`;
  }

  return `Rs. ${digits}${decimal}`;
}

export function percentOf(amountPaisa: number, basisPoints: number): number {
  return Math.round((amountPaisa * basisPoints) / 10_000);
}

export function vatFromNet(netPaisa: number, vatRateBp: number): number {
  return percentOf(netPaisa, vatRateBp);
}

export function vatIncludedInGross(grossPaisa: number, vatRateBp: number): number {
  if (vatRateBp <= 0) {
    return 0;
  }

  return Math.round((grossPaisa * vatRateBp) / (10_000 + vatRateBp));
}
