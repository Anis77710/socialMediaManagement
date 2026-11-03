const nationalPattern = /^(?:96|97|98)\d{8}$/;

export function normalizePhone(
  input: string,
  allowedCountryCodes: readonly string[] = ["977"],
): string | null {
  const digits = input.replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  if (nationalPattern.test(digits)) {
    const countryCode = allowedCountryCodes[0];

    return countryCode ? `+${countryCode}${digits}` : null;
  }

  const codes = [...allowedCountryCodes].sort((left, right) => right.length - left.length);

  for (const countryCode of codes) {
    const withTrunkPrefix = `00${countryCode}`;

    if (digits.startsWith(withTrunkPrefix)) {
      const national = digits.slice(withTrunkPrefix.length);

      return nationalPattern.test(national) ? `+${countryCode}${national}` : null;
    }

    if (digits.startsWith(countryCode)) {
      const national = digits.slice(countryCode.length);

      return nationalPattern.test(national) ? `+${countryCode}${national}` : null;
    }
  }

  return null;
}

export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) {
    return null;
  }

  if (ip.includes(":")) {
    const groups = ip.split(":");

    return `${groups.slice(0, 2).join(":")}:*`;
  }

  const parts = ip.split(".");

  return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.x` : null;
}

export function maskPhone(phoneE164: string): string {
  const national = phoneE164.replace(/^\+\d{1,3}/, "");

  if (national.length <= 4) {
    return phoneE164;
  }

  return `${phoneE164.slice(0, phoneE164.length - national.length)}${national.slice(
    0,
    2,
  )}${"*".repeat(Math.max(national.length - 4, 0))}${national.slice(-2)}`;
}
