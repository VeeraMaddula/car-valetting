import type { Config } from '../config.js';
import { PermanentProviderError } from '../lib/errors.js';

export type EmailPurpose = 'bookings' | 'reminders' | 'payments' | 'accounts';

/** Sender address for a purpose: bookings@ for booking lifecycle and owner alerts, reminders@, payments@, accounts@. */
export function fromFor(config: Config, purpose: EmailPurpose): string {
  switch (purpose) {
    case 'reminders':
      return config.EMAIL_FROM_REMINDERS ?? config.EMAIL_FROM;
    case 'payments':
      return config.EMAIL_FROM_PAYMENTS ?? config.EMAIL_FROM;
    case 'accounts':
      return config.EMAIL_FROM_ACCOUNTS ?? config.EMAIL_FROM;
    default:
      return config.EMAIL_FROM;
  }
}

export interface EmailMessage {
  to: string;
  /** Sender; defaults to EMAIL_FROM. Use fromFor() to pick by purpose. */
  from?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string }[];
}

export type SendResult = { sent: true; id: string } | { sent: false; reason: string };

/** Send through Resend (https://resend.com/docs/api-reference/emails/send-email). */
export async function sendEmail(config: Config, msg: EmailMessage, idempotencyKey: string): Promise<SendResult> {
  if (!config.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      from: msg.from ?? config.EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(config.EMAIL_REPLY_TO ? { reply_to: config.EMAIL_REPLY_TO } : {}),
      ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  if (res.ok) {
    const id = (JSON.parse(body) as { id?: string }).id ?? 'unknown';
    return { sent: true, id };
  }
  // 409: this idempotency key was already used, so the email has been sent before.
  if (res.status === 409) return { sent: false, reason: `duplicate (already sent): ${body}` };
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new PermanentProviderError(`Resend rejected the email (${res.status}): ${body}`);
  }
  throw new Error(`Resend error ${res.status}: ${body}`);
}
