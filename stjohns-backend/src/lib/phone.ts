import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export interface NormalizedPhone {
  e164: string;
  isMobile: boolean;
}

/** Parse a phone number typed by a customer (Irish numbers may omit +353). Returns null if invalid. */
export function normalizePhone(input: string, defaultCountry: 'IE' = 'IE'): NormalizedPhone | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  const type = parsed.getType();
  return {
    e164: parsed.number,
    isMobile: type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE' || type === undefined,
  };
}

export function isMobileNumber(e164: string): boolean {
  return normalizePhone(e164)?.isMobile ?? false;
}

/** Stored in place of the phone number when a customer's personal data is erased (GDPR). */
export const ERASED_PHONE = 'erased';

/** '+353894709672' → '089 470 9672' for Irish numbers, international format otherwise. */
export function displayPhone(e164: string): string {
  if (e164 === ERASED_PHONE) return '—';
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === 'IE' ? parsed.formatNational() : parsed.formatInternational();
}

/** Show only the last three digits, e.g. '••• ••• •672'. */
export function maskPhone(e164: string): string {
  return `••• ••• •${e164.slice(-3)}`;
}
