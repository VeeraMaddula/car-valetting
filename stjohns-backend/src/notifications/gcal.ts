import type { Config } from '../config.js';
import { PermanentProviderError } from '../lib/errors.js';
import { googleClient, googleErrorStatus } from '../lib/google-auth.js';

// The owner shares their Google Calendar with the service account's email ("Make changes to events").
// Bookings then appear in Google Calendar, and on any iPhone where that Google account is added.

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

export function isGoogleCalendarConfigured(config: Config): boolean {
  return Boolean(config.GOOGLE_SERVICE_ACCOUNT_JSON && config.GOOGLE_CALENDAR_ID);
}

/** Deterministic event id (Google allows a–v and 0–9), so retries update instead of duplicating. */
export function googleEventId(bookingId: string): string {
  return `sjp${bookingId.replace(/-/g, '').toLowerCase()}`;
}

export interface CalendarEventBody {
  summary: string;
  description: string;
  location: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  status: 'confirmed' | 'tentative' | 'cancelled';
  colorId?: string;
}

/** Create or update the booking's event (PUT, falling back to insert with our id). */
export async function upsertCalendarEvent(config: Config, bookingId: string, body: CalendarEventBody): Promise<string> {
  const id = googleEventId(bookingId);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.GOOGLE_CALENDAR_ID!)}/events`;
  const client = googleClient(config, SCOPES);
  try {
    await client.request({ url: `${base}/${id}`, method: 'PUT', data: body, timeout: 10_000 });
    return id;
  } catch (err) {
    const status = googleErrorStatus(err);
    if (status !== 404) throw classify(err, status);
  }
  try {
    await client.request({ url: base, method: 'POST', data: { ...body, id }, timeout: 10_000 });
    return id;
  } catch (err) {
    throw classify(err, googleErrorStatus(err));
  }
}

function classify(err: unknown, status: number | undefined): Error {
  const message = err instanceof Error ? err.message : String(err);
  // 400 = bad request, 401 = broken credentials, 404 = calendar not shared with the service account.
  if (status === 400 || status === 401 || status === 404) {
    return new PermanentProviderError(`Google Calendar rejected the request (${status}): ${message}`);
  }
  return err instanceof Error ? err : new Error(message);
}
