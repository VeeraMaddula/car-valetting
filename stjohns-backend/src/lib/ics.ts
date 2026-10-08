// RFC 5545 calendar files. Apple Calendar (iPhone, iPad, Mac, iCloud) opens these directly from
// email attachments and links; Google Calendar and Outlook accept them too.

export type IcsTiming =
  | { kind: 'allDay'; date: string }
  | { kind: 'timed'; start: Date; end: Date };

export interface IcsEvent {
  uid: string;
  sequence: number;
  summary: string;
  description: string;
  location: string;
  timing: IcsTiming;
  cancelled?: boolean;
  url?: string;
  updatedAt: Date;
}

export interface IcsCalendar {
  name: string;
  method?: 'PUBLISH' | 'CANCEL';
  events: IcsEvent[];
  refreshMinutes?: number;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets, never splitting a UTF-8 character. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 75) {
      out.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateValue(date: string): string {
  return date.replace(/-/g, '');
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function eventLines(e: IcsEvent, now: Date): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${utcStamp(now)}`,
    `LAST-MODIFIED:${utcStamp(e.updatedAt)}`,
  ];
  if (e.timing.kind === 'allDay') {
    lines.push(`DTSTART;VALUE=DATE:${dateValue(e.timing.date)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(e.timing.date))}`);
  } else {
    lines.push(`DTSTART:${utcStamp(e.timing.start)}`, `DTEND:${utcStamp(e.timing.end)}`);
  }
  lines.push(
    `SUMMARY:${escapeText(e.summary)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    `LOCATION:${escapeText(e.location)}`,
    `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  );
  if (e.url) lines.push(`URL:${e.url}`);
  if (!e.cancelled) {
    // Remind 1 hour before a timed slot, or at 6pm the evening before an all-day one.
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:${e.timing.kind === 'timed' ? '-PT1H' : '-PT6H'}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(cal: IcsCalendar, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//St Johns Park Car Valeting//Bookings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${cal.method ?? 'PUBLISH'}`,
    `X-WR-CALNAME:${escapeText(cal.name)}`,
  ];
  if (cal.refreshMinutes) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${cal.refreshMinutes}M`, `X-PUBLISHED-TTL:PT${cal.refreshMinutes}M`);
  }
  for (const e of cal.events) lines.push(...eventLines(e, now));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
