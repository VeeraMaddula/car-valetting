import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { Config } from '../config.js';
import { PermanentProviderError } from '../lib/errors.js';
import type { SendResult } from './resend.js';

function recipient(config: Config, e164: string): string {
  if (config.SENDMODE_NUMBER_FORMAT === 'national') {
    const parsed = parsePhoneNumberFromString(e164);
    if (parsed?.country === 'IE') return parsed.formatNational().replace(/\s/g, '');
  }
  return e164.replace(/^\+/, '');
}

/** Send an SMS through Sendmode's v2 REST API (https://developers.sendmode.com/restdocs/send). */
export async function sendSms(config: Config, toE164: string, text: string, customerId: string): Promise<SendResult> {
  if (!config.SENDMODE_ACCESS_KEY) return { sent: false, reason: 'SENDMODE_ACCESS_KEY not set' };
  const message = {
    messagetext: text,
    senderid: config.SENDMODE_SENDER_ID,
    recipients: [recipient(config, toE164)],
    customerid: customerId,
  };
  const res = await fetch('https://rest.sendmode.com/v2/send', {
    method: 'POST',
    headers: {
      Authorization: config.SENDMODE_ACCESS_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ message: JSON.stringify(message) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  let parsed: { status?: string; statusCode?: number } | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (res.ok && parsed?.status === 'OK') return { sent: true, id: customerId };
  if (res.status === 401 || res.status === 403) {
    throw new PermanentProviderError(`Sendmode rejected the access key (${res.status}): ${body}`);
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new PermanentProviderError(`Sendmode rejected the SMS (${res.status}): ${body}`);
  }
  throw new Error(`Sendmode error ${res.status}: ${body}`);
}
