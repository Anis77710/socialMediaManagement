import { addDays, startOfNptDay } from "./nepali.js";

export const NPT_TIMEZONE = "Asia/Kathmandu";

export function nowUtc(): Date {
  return new Date();
}

export function nptHour(date: Date): number {
  return Math.floor(nptMinutesOfDay(date) / 60) % 24;
}

export function nptMinutesOfDay(date: Date): number {
  const shifted = new Date(date.getTime() + (5 * 60 + 45) * 60_000);

  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function nptWeekday(date: Date): number {
  const shifted = new Date(date.getTime() + (5 * 60 + 45) * 60_000);

  return shifted.getUTCDay();
}

export function isQuietHours(date: Date): boolean {
  const minutes = nptMinutesOfDay(date);

  return minutes >= 21 * 60 || minutes < 7 * 60;
}

export function isWorkingHours(date: Date, startHour = 10, endHour = 18): boolean {
  const weekday = nptWeekday(date);
  const minutes = nptMinutesOfDay(date);

  return weekday !== 6 && minutes >= startHour * 60 && minutes < endHour * 60;
}

export function nextWeekday(date: Date, weekdays: number[], windowStart: string): Date {
  const [startHour = "10", startMinute = "00"] = windowStart.split(":");
  const base = startOfNptDay(date);

  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = addDays(base, offset);
    const weekday = nptWeekday(candidate);

    if (!weekdays.includes(weekday)) {
      continue;
    }

    const minutes = Number(startHour) * 60 + Number(startMinute);
    const result = new Date(candidate.getTime() + minutes * 60_000);

    if (result > date) {
      return result;
    }
  }

  return addDays(base, 1);
}

export function weekStartNpt(date: Date): Date {
  const start = startOfNptDay(date);
  const weekday = nptWeekday(start);

  return addDays(start, -weekday);
}

export function workingHoursBetween(from: Date, hours: number): Date {
  let cursor = new Date(from);
  let remaining = hours;

  while (remaining > 0) {
    if (isWorkingHours(cursor)) {
      remaining -= 1;
      cursor = new Date(cursor.getTime() + 3_600_000);
    } else {
      cursor = new Date(cursor.getTime() + 30 * 60_000);
    }
  }

  return cursor;
}
