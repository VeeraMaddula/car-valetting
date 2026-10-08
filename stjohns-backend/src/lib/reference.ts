import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so references are easy to read out over the phone.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VALID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** A new 8-character booking reference (40 random bits), stored without prefix or dashes. */
export function newReference(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/** 'K7Q49XZ2' → 'SJP-K7Q4-9XZ2'. */
export function formatReference(ref: string): string {
  return `SJP-${ref.slice(0, 4)}-${ref.slice(4)}`;
}

/** Accepts what a customer might type ('sjp-k7q4 9xz2', 'K7Q49XZ2') and returns the stored form, or null. */
export function normalizeReference(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 11 && s.startsWith('SJP')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return VALID.test(s) ? s : null;
}
