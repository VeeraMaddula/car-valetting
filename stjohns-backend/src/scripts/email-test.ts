// Send one test email through Resend using the settings in .env, and explain the usual setup problems.
// Usage: npm run email:test                                   (sends to OWNER_EMAIL)
//        npm.cmd run email:test -- --to someone@example.com   (PowerShell needs npm.cmd to pass --to)
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { sendEmail } from '../notifications/resend.js';

const { values } = parseArgs({ options: { to: { type: 'string' } } });
const config = loadConfig();
const to = values.to?.trim() || config.OWNER_EMAIL;

function explain(message: string): string {
  if (/only send testing emails to your own email/i.test(message)) {
    return 'Until your domain is verified, Resend only delivers to the address you signed up with. Send to that address, or verify your domain (README › Resend).';
  }
  if (/domain is not verified/i.test(message)) {
    return 'EMAIL_FROM uses a domain Resend has not verified yet. Until it is, set EMAIL_FROM="St Johns Park Valeting <onboarding@resend.dev>".';
  }
  if (/api key is invalid|missing api key|\(401\)/i.test(message)) {
    return 'Resend rejected the API key. Copy it again into RESEND_API_KEY in .env (no quotes or spaces).';
  }
  return message;
}

function fail(message: string): never {
  console.error(`\nEmail test failed: ${message}`);
  process.exit(1);
}

if (!config.RESEND_API_KEY) fail('RESEND_API_KEY is empty in .env. Create a key at https://resend.com/api-keys and paste it there.');
if (!to) fail('No recipient. Set OWNER_EMAIL in .env, or pass --to.');

console.log(`Sending a test email from ${config.EMAIL_FROM} to ${to}…`);
try {
  const result = await sendEmail(
    config,
    {
      to,
      subject: `Test email from ${config.BUSINESS_NAME}`,
      html: `<p>This is a test email from the ${config.BUSINESS_NAME} booking system.</p><p>If you can read this, booking emails are set up correctly.</p>`,
      text: `This is a test email from the ${config.BUSINESS_NAME} booking system.\n\nIf you can read this, booking emails are set up correctly.`,
    },
    `email-test-${randomUUID()}`,
  );
  if (!result.sent) fail(result.reason);
  console.log(`\nSent (Resend id ${result.id}). Check the inbox for ${to}, including spam.`);
} catch (err) {
  fail(explain(err instanceof Error ? err.message : String(err)));
}
