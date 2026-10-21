import type { Config } from '../config.js';
import type { BookingRecord } from '../domain/bookings.js';
import { calendarUrl, depositPayUrl, timeLabel, trackUrl, whenLabel } from '../domain/bookings.js';
import { euros, SIZE_LABELS } from '../domain/pricing.js';
import type { NotifyTemplate } from '../jobs/queue.js';
import { displayPhone } from '../lib/phone.js';
import { formatReference } from '../lib/reference.js';
import { longDate, shortDate } from '../lib/time.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Attach the booking as an .ics file (opens in Apple Calendar on iPhone/iCloud). */
  attachCalendar: boolean;
}

const GOLD = '#C9A24A';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

interface LayoutInput {
  preheader: string;
  eyebrow: string;
  heading: string;
  intro: string[];
  rows: [string, string][];
  cta?: { label: string; url: string };
  secondary?: { label: string; url: string };
  outro?: string[];
}

function layout(config: Config, x: LayoutInput): { html: string; text: string } {
  const rows = x.rows
    .map(
      ([k, v]) => `<tr>
<td style="padding:10px 0;border-bottom:1px solid #2a251c;color:#A69F91;font-size:12px;letter-spacing:2px;text-transform:uppercase;width:38%;vertical-align:top">${esc(k)}</td>
<td style="padding:10px 0;border-bottom:1px solid #2a251c;color:#F4EEE3;font-size:15px;vertical-align:top">${esc(v)}</td>
</tr>`,
    )
    .join('');
  const button = (b: { label: string; url: string }, primary: boolean) =>
    `<a href="${esc(b.url)}" style="display:inline-block;padding:14px 26px;margin:0 8px 8px 0;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;text-decoration:none;${
      primary ? `background:${GOLD};color:#0B0A08` : `border:1px solid #6b6252;color:#F4EEE3`
    }">${esc(b.label)}</a>`;
  const paragraphs = (ps: string[]) =>
    ps.map((p) => `<p style="margin:0 0 14px;color:#CFC8BA;font-size:15px;line-height:1.6">${esc(p)}</p>`).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(x.heading)}</title></head>
<body style="margin:0;padding:0;background:#0B0A08">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(x.preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B0A08"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;font-family:Arial,Helvetica,sans-serif">
<tr><td style="padding:0 0 24px;text-align:center">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;letter-spacing:3px;color:${GOLD}">ST JOHNS PARK</div>
<div style="font-size:10px;letter-spacing:5px;color:#F4EEE3;margin-top:4px">CAR VALETING SERVICE</div>
</td></tr>
<tr><td style="background:#13110D;border:1px solid #3a3224;padding:36px 32px">
<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${GOLD};margin-bottom:12px">${esc(x.eyebrow)}</div>
<h1 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:30px;line-height:1.15;color:#F4EEE3">${esc(x.heading)}</h1>
${paragraphs(x.intro)}
${rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 24px">${rows}</table>` : ''}
${x.cta ? button(x.cta, true) : ''}${x.secondary ? button(x.secondary, false) : ''}
${x.outro ? `<div style="margin-top:20px">${paragraphs(x.outro)}</div>` : ''}
</td></tr>
<tr><td style="padding:24px 8px;text-align:center;color:#8E8779;font-size:12px;line-height:1.6">
${esc(config.BUSINESS_NAME)}<br>${esc(config.BUSINESS_ADDRESS)}<br>${esc(config.BUSINESS_PHONE)}
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    x.heading,
    '',
    ...x.intro,
    '',
    ...x.rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(x.cta ? [`${x.cta.label}: ${x.cta.url}`] : []),
    ...(x.secondary ? [`${x.secondary.label}: ${x.secondary.url}`] : []),
    ...(x.outro ? ['', ...x.outro] : []),
    '',
    `${config.BUSINESS_NAME} · ${config.BUSINESS_PHONE}`,
  ].join('\n');

  return { html, text };
}

/** 'From €76.50 (includes SPRING15: −€13.50)'. */
export function priceLine(b: BookingRecord): string | null {
  if (b.totalCents === null) return null;
  const discount = b.discountCode ? ` (includes ${b.discountCode}: −${euros(b.discountCents)})` : '';
  return `${b.servicePriceFrom ? 'From ' : ''}${euros(b.totalCents)}${discount}`;
}

function bookingRows(b: BookingRecord, config: Config): [string, string][] {
  const rows: [string, string][] = [
    ['Reference', formatReference(b.reference)],
    ['Service', b.serviceName],
    ['Date', longDate(b.slotDate)],
    ['Slot', `${b.periodLabel} · ${timeLabel(b)}`],
    ['Vehicle', b.vehicleSize ? `${b.vehicle} (${SIZE_LABELS[b.vehicleSize]})` : b.vehicle],
    ['Handover', b.handover === 'collection' ? `Collection from ${b.collectionAddress ?? ''}` : `Drop off at ${config.BUSINESS_ADDRESS}`],
  ];
  if (b.addons.length) rows.push(['Extras', b.addons.map((a) => `${a.name} (+${euros(a.priceCents)})`).join(', ')]);
  const price = priceLine(b);
  if (price) rows.push(['Price', price]);
  return rows;
}

export function customerEmail(template: NotifyTemplate, b: BookingRecord, config: Config, extra: { reviewUrl?: string | null } = {}): RenderedEmail | null {
  const ref = formatReference(b.reference);
  const track = { label: 'Track booking', url: trackUrl(config, b) };
  const addToCalendar = { label: 'Add to calendar', url: calendarUrl(config, b) };
  const help = [`Need to change something? Call us on ${config.BUSINESS_PHONE} and quote ${ref}.`];
  const name = firstName(b.customerName);
  switch (template) {
    case 'created':
      return {
        subject: `Booking received: ${shortDate(b.slotDate)}, ${b.periodLabel} (${ref})`,
        attachCalendar: true,
        ...layout(config, {
          preheader: `We're holding ${whenLabel(b)} for you.`,
          eyebrow: 'Booking received',
          heading: `Thanks, ${name}. Your slot is held.`,
          intro: [
            `We've received your booking and are holding ${whenLabel(b)} for you. We'll confirm shortly.`,
            config.DEPOSIT_AMOUNT_EUR > 0 ? `A €${config.DEPOSIT_AMOUNT_EUR} deposit is requested once we approve your booking. Nothing is charged now.` : '',
          ].filter(Boolean),
          rows: bookingRows(b, config),
          cta: track,
          secondary: addToCalendar,
          outro: help,
        }),
      };
    case 'confirmed':
      return {
        subject: `Confirmed: your valet on ${shortDate(b.slotDate)} (${ref})`,
        attachCalendar: true,
        ...layout(config, {
          preheader: `See you ${whenLabel(b)}.`,
          eyebrow: 'Booking confirmed',
          heading: 'Your valet is confirmed.',
          intro: [`Great news, ${name}. We'll see you ${whenLabel(b)}.`],
          rows: bookingRows(b, config),
          cta: addToCalendar,
          secondary: track,
          outro: help,
        }),
      };
    case 'reminder':
      return {
        subject: `Reminder: your valet is tomorrow (${ref})`,
        attachCalendar: false,
        ...layout(config, {
          preheader: `Tomorrow: ${whenLabel(b)}.`,
          eyebrow: 'See you tomorrow',
          heading: 'Your valet is tomorrow.',
          intro: [
            b.handover === 'collection'
              ? `We'll collect your car from ${b.collectionAddress ?? 'your address'} for your ${b.periodLabel.toLowerCase()} slot.`
              : `Please drop your car at ${config.BUSINESS_ADDRESS} for your ${b.periodLabel.toLowerCase()} slot.`,
            'Remove any valuables before handing over your keys.',
          ],
          rows: bookingRows(b, config),
          cta: track,
          outro: help,
        }),
      };
    case 'cancelled':
    case 'cancelled_by_customer':
      return {
        subject: `Booking cancelled: ${ref}`,
        attachCalendar: true,
        ...layout(config, {
          preheader: `Your booking for ${longDate(b.slotDate)} has been cancelled.`,
          eyebrow: 'Booking cancelled',
          heading: 'Your booking has been cancelled.',
          intro: [`Your ${b.serviceName} on ${whenLabel(b)} has been cancelled. If this wasn't expected, please call us.`],
          rows: [
            ['Reference', ref],
            ['Was booked for', whenLabel(b)],
          ],
          cta: { label: 'Book another slot', url: config.PUBLIC_SITE_URL },
          outro: [`Questions? Call ${config.BUSINESS_PHONE}.`],
        }),
      };
    case 'deposit_requested': {
      const payUrl = depositPayUrl(b);
      const amount = `€${config.DEPOSIT_AMOUNT_EUR}`;
      return {
        subject: `Pay your ${amount} deposit to secure your valet (${ref})`,
        attachCalendar: false,
        ...layout(config, {
          preheader: `Secure ${whenLabel(b)} with a ${amount} deposit.`,
          eyebrow: 'One last step',
          heading: `Your ${amount} deposit`,
          intro: payUrl
            ? [
                `To secure ${whenLabel(b)}, please pay the ${amount} deposit using the secure link below. It's deducted from the price on the day.`,
                `Card, Apple Pay and Google Pay are accepted. The link is valid for ${Math.round(config.DEPOSIT_LINK_HOURS)} hours.`,
              ]
            : [`To secure ${whenLabel(b)}, please pay the ${amount} deposit.`, config.DEPOSIT_INSTRUCTIONS],
          rows: bookingRows(b, config),
          cta: payUrl ? { label: `Pay ${amount} deposit`, url: payUrl } : track,
          secondary: payUrl ? track : undefined,
          outro: help,
        }),
      };
    }
    case 'deposit_paid':
      return {
        subject: `Deposit received: thank you (${ref})`,
        attachCalendar: false,
        ...layout(config, {
          preheader: `Your €${config.DEPOSIT_AMOUNT_EUR} deposit is in. See you ${whenLabel(b)}.`,
          eyebrow: 'Deposit received',
          heading: `Thanks, ${name}. Your slot is secured.`,
          intro: [
            `We've received your €${config.DEPOSIT_AMOUNT_EUR} deposit for ${whenLabel(b)}. It will be deducted from the price on the day.`,
            'A receipt from our payment provider is on its way separately.',
          ],
          rows: bookingRows(b, config),
          cta: track,
          secondary: addToCalendar,
          outro: help,
        }),
      };
    case 'deposit_refunded':
      return {
        subject: `Deposit refunded (${ref})`,
        attachCalendar: false,
        ...layout(config, {
          preheader: `Your €${config.DEPOSIT_AMOUNT_EUR} deposit has been refunded.`,
          eyebrow: 'Deposit refunded',
          heading: 'Your deposit is on its way back.',
          intro: [
            `We've refunded your €${config.DEPOSIT_AMOUNT_EUR} deposit for booking ${ref}. Refunds usually show on your card within 5–10 working days.`,
          ],
          rows: [
            ['Reference', ref],
            ['Was booked for', whenLabel(b)],
          ],
          cta: { label: 'Book another slot', url: config.PUBLIC_SITE_URL },
          outro: [`Questions? Call ${config.BUSINESS_PHONE}.`],
        }),
      };
    case 'completed':
      return {
        subject: 'Thanks for choosing St Johns Park',
        attachCalendar: false,
        ...layout(config, {
          preheader: 'Your car is ready. Thank you!',
          eyebrow: 'All done',
          heading: `Thank you, ${name}.`,
          intro: ['We hope you love the finish. When you are ready for your next valet, your slot is a minute away.'],
          rows: [
            ['Reference', ref],
            ['Service', b.serviceName],
          ],
          cta: { label: 'Book again', url: config.PUBLIC_SITE_URL },
        }),
      };
    case 'review_request':
      if (!extra.reviewUrl) return null;
      return {
        subject: `How did we do, ${name}?`,
        attachCalendar: false,
        ...layout(config, {
          preheader: 'A quick Google review helps a small local business more than you might think.',
          eyebrow: 'Thank you',
          heading: 'How was your valet?',
          intro: [
            `Thanks again for choosing us for your ${b.serviceName}, ${name}.`,
            'If you were happy with the finish, a short Google review would mean a lot to us. It takes under a minute.',
          ],
          rows: [],
          cta: { label: 'Leave a review', url: extra.reviewUrl },
          outro: [`Not happy with something? Reply to this email or call ${config.BUSINESS_PHONE} and we'll put it right.`],
        }),
      };
  }
}

export function ownerEmail(template: NotifyTemplate, b: BookingRecord, config: Config): RenderedEmail | null {
  const ref = formatReference(b.reference);
  const rows: [string, string][] = [
    ['Reference', ref],
    ['Customer', b.customerName],
    ['Phone', displayPhone(b.customerPhone)],
    ['Email', b.customerEmail ?? '—'],
    ...bookingRows(b, config).slice(1),
    ['Notes', b.notes ?? '—'],
  ];
  const call = { label: 'Call customer', url: `tel:${b.customerPhone}` };
  if (template === 'created') {
    return {
      subject: `New booking: ${shortDate(b.slotDate)} ${b.periodLabel}, ${b.customerName} (${ref})`,
      attachCalendar: false,
      ...layout(config, {
        preheader: `${b.serviceName} for ${b.customerName}`,
        eyebrow: 'New booking',
        heading: `${b.serviceName}: ${shortDate(b.slotDate)}, ${b.periodLabel}`,
        intro: [b.status === 'confirmed' ? 'A new booking came in and was confirmed automatically.' : 'A new booking is waiting for your confirmation.'],
        rows,
        cta: call,
      }),
    };
  }
  if (template === 'deposit_paid') {
    return {
      subject: `Deposit paid: ${shortDate(b.slotDate)} ${b.periodLabel}, ${b.customerName} (${ref})`,
      attachCalendar: false,
      ...layout(config, {
        preheader: `€${config.DEPOSIT_AMOUNT_EUR} received for ${ref}`,
        eyebrow: 'Deposit paid',
        heading: `€${config.DEPOSIT_AMOUNT_EUR} received for ${shortDate(b.slotDate)}, ${b.periodLabel}`,
        intro: [`${b.customerName} has paid the deposit online. Balance due on the day.`],
        rows,
        cta: call,
      }),
    };
  }
  if (template === 'cancelled_by_customer') {
    return {
      subject: `Cancelled: ${shortDate(b.slotDate)} ${b.periodLabel}, ${b.customerName} (${ref})`,
      attachCalendar: false,
      ...layout(config, {
        preheader: `${b.customerName} cancelled their booking.`,
        eyebrow: 'Cancelled by customer',
        heading: `${shortDate(b.slotDate)} ${b.periodLabel} is free again`,
        intro: [`${b.customerName} cancelled online${b.cancelReason ? `: "${b.cancelReason}"` : '.'}`],
        rows,
        cta: call,
      }),
    };
  }
  return null;
}

function slotShort(b: BookingRecord): string {
  return `${shortDate(b.slotDate)}, ${b.periodLabel}${b.startTime ? ` ${timeLabel(b)}` : ''}`;
}

export function customerSms(template: NotifyTemplate, b: BookingRecord, config: Config): string | null {
  const ref = formatReference(b.reference);
  switch (template) {
    case 'created':
      return `St Johns Park: booking ${ref} received for ${slotShort(b)}. We'll confirm soon. Track: ${trackUrl(config, b)}`;
    case 'confirmed':
      return `St Johns Park: your valet on ${slotShort(b)} is confirmed. Ref ${ref}. Add to calendar: ${calendarUrl(config, b)}`;
    case 'reminder':
      return `Reminder from St Johns Park: your valet is tomorrow, ${slotShort(b)}. ${
        b.handover === 'collection' ? "We'll collect your car." : 'Please drop your car to us.'
      } Questions? ${config.BUSINESS_PHONE}`;
    case 'cancelled':
    case 'cancelled_by_customer':
      return `St Johns Park: booking ${ref} for ${shortDate(b.slotDate)} has been cancelled. Questions? ${config.BUSINESS_PHONE}`;
    case 'deposit_requested': {
      const payUrl = depositPayUrl(b);
      return payUrl
        ? `St Johns Park: pay your €${config.DEPOSIT_AMOUNT_EUR} deposit to secure ${slotShort(b)} (${ref}): ${payUrl}`
        : `St Johns Park: please pay the €${config.DEPOSIT_AMOUNT_EUR} deposit to secure ${slotShort(b)} (${ref}). ${config.DEPOSIT_INSTRUCTIONS}`;
    }
    case 'deposit_paid':
      return `St Johns Park: €${config.DEPOSIT_AMOUNT_EUR} deposit received for ${slotShort(b)} (${ref}). Your slot is secured, thank you.`;
    case 'deposit_refunded':
      return `St Johns Park: your €${config.DEPOSIT_AMOUNT_EUR} deposit for ${ref} has been refunded. Allow 5–10 working days. Questions? ${config.BUSINESS_PHONE}`;
    case 'completed':
    case 'review_request':
      return null;
  }
}

export function ownerSms(template: NotifyTemplate, b: BookingRecord): string | null {
  const ref = formatReference(b.reference);
  if (template === 'created') {
    return `New booking ${ref}: ${b.serviceName}, ${slotShort(b)}. ${b.customerName} ${displayPhone(b.customerPhone)}. ${b.vehicle}${
      b.handover === 'collection' ? '. COLLECTION' : ''
    }`;
  }
  if (template === 'cancelled_by_customer') {
    return `Cancelled by customer: ${ref}, ${slotShort(b)}. ${b.customerName} ${displayPhone(b.customerPhone)}`;
  }
  if (template === 'deposit_paid') {
    return `Deposit paid: ${ref}, ${slotShort(b)}. ${b.customerName}`;
  }
  return null;
}

export function passwordResetEmail(config: Config, fullName: string, link: string): RenderedEmail {
  return {
    subject: 'Reset your St Johns Park password',
    attachCalendar: false,
    ...layout(config, {
      preheader: 'Use this link within 1 hour to choose a new password.',
      eyebrow: 'Password reset',
      heading: `Hi ${firstName(fullName)}, reset your password`,
      intro: ['Someone (hopefully you) asked to reset the password for your account. The link below works once, for 1 hour.'],
      rows: [],
      cta: { label: 'Choose a new password', url: link },
      outro: ["If you didn't ask for this, you can ignore this email. Your password won't change."],
    }),
  };
}

export interface SummaryLine {
  period: string;
  customer: string;
  detail: string;
}

/** 8am email to the owner: today's bookings and anything waiting for them. */
export function ownerDailySummaryEmail(
  config: Config,
  date: string,
  lines: SummaryLine[],
  counts: { pending: number; depositsOutstanding: number },
  adminUrl: string,
): RenderedEmail {
  const waiting = [
    counts.pending ? `${counts.pending} booking${counts.pending === 1 ? '' : 's'} waiting for your confirmation.` : '',
    counts.depositsOutstanding ? `${counts.depositsOutstanding} deposit${counts.depositsOutstanding === 1 ? '' : 's'} requested but not paid yet.` : '',
  ].filter(Boolean);
  return {
    subject: `Today: ${lines.length ? `${lines.length} booking${lines.length === 1 ? '' : 's'}` : 'no bookings'} (${shortDate(date)})`,
    attachCalendar: false,
    ...layout(config, {
      preheader: lines.map((l) => `${l.period}: ${l.customer}`).join(' · ') || 'No bookings today.',
      eyebrow: 'Daily summary',
      heading: longDate(date),
      intro: [lines.length ? "Here's your day." : 'No bookings today.', ...waiting],
      rows: lines.map((l) => [l.period, `${l.customer} · ${l.detail}`]),
      cta: { label: 'Open bookings', url: adminUrl },
    }),
  };
}

const ACCESS_LABELS = { staff: 'bookings', admin: 'full' } as const;

export function teamInviteEmail(config: Config, inviter: string, role: 'staff' | 'admin', link: string, hasAccount: boolean): RenderedEmail {
  return {
    subject: `You're invited to manage ${config.BUSINESS_NAME}`,
    attachCalendar: false,
    ...layout(config, {
      preheader: `${inviter} invited you to the booking dashboard with ${ACCESS_LABELS[role]} access.`,
      eyebrow: 'Team invite',
      heading: 'Join the booking dashboard',
      intro: [
        `${inviter} has invited you to the ${config.BUSINESS_NAME} dashboard with ${ACCESS_LABELS[role]} access.`,
        hasAccount
          ? 'Open the link and sign in with your existing account (this email address) to accept. The link works for 7 days.'
          : 'Open the link and create your login with this email address. The link works for 7 days.',
      ],
      rows: [],
      cta: { label: 'Accept invite', url: link },
      outro: ["If you weren't expecting this, you can ignore this email."],
    }),
  };
}

export function testEmail(config: Config): RenderedEmail {
  return {
    subject: `Test email from ${config.BUSINESS_NAME}`,
    attachCalendar: false,
    ...layout(config, {
      preheader: 'Booking emails are set up correctly.',
      eyebrow: 'Test',
      heading: 'Email is working',
      intro: ['This is a test from your booking dashboard. If you can read this, customers will receive their booking emails.'],
      rows: [],
    }),
  };
}
