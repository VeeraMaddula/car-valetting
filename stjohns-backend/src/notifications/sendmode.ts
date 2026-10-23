import type { Config } from '../config.js';
import { PermanentProviderError } from '../lib/errors.js';
import type { SendResult } from './resend.js';

/** Sendmode Engage REST 3.0 (https://engage.sendmode.com/apireference/#/send). */
const SENDMODE_SEND_URL = 'https://sms-rest.sendmode.dev/3.0/send';

/** Send an SMS through Sendmode's REST 3.0 API. Numbers go in E.164 (+353…); '<' and '>' are not allowed in the text. */
export async function sendSms(config: Config, toE164: string, text: string, customerId: string): Promise<SendResult> {
  if (!config.SENDMODE_ACCESS_KEY) return { sent: false, reason: 'SENDMODE_ACCESS_KEY not set' };
  const res = await fetch(SENDMODE_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: config.SENDMODE_ACCESS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_id: config.SENDMODE_SENDER_ID,
      message: text.replace(/[<>]/g, '').slice(0, 1224),
      mobile_number: toE164.startsWith('+') ? toE164 : `+${toE164}`,
      customer_id: customerId,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  let parsed: { is_successful?: boolean; request_id?: string; error_message?: string | null } | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (res.ok && parsed?.is_successful) return { sent: true, id: parsed.request_id ?? customerId };
  if (res.status === 401 || res.status === 403) {
    throw new PermanentProviderError(`Sendmode rejected the access key (${res.status}): ${body}`);
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new PermanentProviderError(`Sendmode rejected the SMS (${res.status}): ${parsed?.error_message ?? body}`);
  }
  throw new Error(`Sendmode error ${res.status}: ${body}`);
}
