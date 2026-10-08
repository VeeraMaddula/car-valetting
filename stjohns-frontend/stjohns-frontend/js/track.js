// Track a booking with its reference + phone number: status, progress, history, calendar links and online cancellation.
import { api } from './api.js';
import { BUSINESS } from './config.js';
import { addDays, clearFieldError, currentUser, el, fmt, icon, ICONS, param, showFieldErrors, toast } from './ui.js';

const TIMEZONE = 'Europe/Dublin';
const ACTIVE = new Set(['pending', 'confirmed']);
const ENDED_EVENTS = new Set(['cancelled', 'no_show']);

const form = document.getElementById('track-form');
const submitBtn = form.querySelector('[type="submit"]');
const views = [...document.querySelectorAll('[data-view]')];
const result = document.querySelector('[data-view="result"]');
const $ = (selector) => result.querySelector(selector);
const changeStates = [...result.querySelectorAll('[data-change]')];

/** The booking on screen plus the phone number that proved access to it (needed again to cancel). */
let state = { booking: null, phone: '', cancelStep: 'idle' };

// ---------- Helpers ----------

/** Same rules as the API: accepts 'sjp-k7q4 9xz2' or 'K7Q49XZ2' and returns 'SJP-K7Q4-9XZ2', or null. */
function normalizeRef(input) {
  let s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 11 && s.startsWith('SJP')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? `SJP-${s.slice(0, 4)}-${s.slice(4)}` : null;
}

function euro(amount) {
  const n = Number(amount) || 0;
  return `€${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

function setBusy(button, busy) {
  button.setAttribute('aria-disabled', String(busy));
  button.setAttribute('aria-busy', String(busy));
  const spinner = button.querySelector('.spinner');
  if (busy && !spinner) button.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  if (!busy && spinner) spinner.remove();
}
const isBusy = (button) => button.getAttribute('aria-busy') === 'true';

function show(name) {
  views.forEach((v) => { v.hidden = v.dataset.view !== name; });
}

function phoneLink() {
  return el('a', { href: BUSINESS.phoneHref, text: BUSINESS.phone });
}

/** 'HH:MM' + hours, capped at the end of the day. */
function addHours(time, hours) {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(h * 60 + m + hours * 60, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Google Calendar "add event" link: all-day while the slot time is unset, otherwise local Irish times. */
function googleCalendarUrl(b) {
  const day = b.date.replace(/-/g, '');
  const start = b.period.startTime;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: `${b.service.name} — St Johns Park Valeting` });
  if (start) {
    const end = b.period.endTime || addHours(start, 3);
    params.set('dates', `${day}T${start.replace(':', '')}00/${day}T${end.replace(':', '')}00`);
    params.set('ctz', TIMEZONE);
  } else {
    params.set('dates', `${day}/${addDays(b.date, 1).replace(/-/g, '')}`);
  }
  params.set('details', [
    `Booking ${b.reference} (${b.statusLabel})`,
    `${b.period.label} slot · ${b.timeLabel}`,
    `Vehicle: ${b.vehicle}`,
    `Questions? Call ${BUSINESS.phone}`,
    b.trackUrl ? `Track: ${b.trackUrl}` : '',
  ].filter(Boolean).join('\n'));
  const location = b.handover === 'collection' ? b.collectionAddress : BUSINESS.address;
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params}`;
}

function eventAt(b, type) {
  const event = (b.timeline || []).find((t) => t.type === type);
  return event ? event.at : null;
}

function handoverLabel(b) {
  if (b.handover !== 'collection') return 'Drop off at St Johns Park';
  return b.collectionAddress ? `Collection from ${b.collectionAddress}` : 'We collect your car';
}

// ---------- Rendering ----------

function steps(b) {
  const confirmed = ['confirmed', 'completed', 'no_show'].includes(b.status);
  const depositDone = ['paid', 'waived'].includes(b.deposit.status);
  const confirmedAt = eventAt(b, 'confirmed');
  const amount = euro(b.deposit.amountEur);
  const depositSub = {
    paid: `${amount} received`,
    waived: 'Waived',
    requested: `${amount} requested`,
    refunded: `${amount} refunded`,
  }[b.deposit.status] || `${amount} after confirmation`;
  const list = [
    { label: 'Requested', sub: fmt.dateTime(b.createdAt), done: true },
    { label: 'Confirmed', sub: confirmed ? (confirmedAt ? fmt.dateTime(confirmedAt) : 'Slot confirmed') : 'Usually within a few hours', done: confirmed },
    { label: 'Deposit', sub: depositSub, done: depositDone },
    { label: 'Valet day', sub: fmt.short(b.date), done: b.status === 'completed' },
  ];
  // While the booking is live, the first unfinished step is the one we're waiting on.
  const current = ACTIVE.has(b.status) ? list.findIndex((s) => !s.done) : -1;
  return list.map((s, i) => ({ ...s, current: i === current }));
}

function stepItem(s, i) {
  const status = s.done ? 'done' : s.current ? 'in progress' : 'to come';
  return el('li', { class: `step${s.done ? ' is-done' : ''}${s.current ? ' is-current' : ''}`, 'aria-current': s.current ? 'step' : null },
    el('span', { class: 'step-head', 'aria-hidden': 'true' },
      el('span', { class: 'step-mark' }, s.done ? icon(ICONS.check, 16) : String(i + 1)),
      el('span', { class: 'step-line' })),
    el('span', { class: 'step-label' }, s.label, el('span', { class: 'sr-only', text: `: ${status}` })),
    el('span', { class: 'step-sub', text: s.sub }));
}

function renderResult() {
  const b = state.booking;
  const cancelled = b.status === 'cancelled';

  $('[data-ref]').textContent = b.reference;
  const pill = $('[data-status]');
  pill.className = `pill pill-lg pill-${b.status}`;
  pill.textContent = b.statusLabel;

  const stepList = $('[data-steps]');
  stepList.hidden = cancelled;
  stepList.replaceChildren(...(cancelled ? [] : steps(b).map(stepItem)));
  $('[data-cancelled-note]').hidden = !cancelled;

  const details = [
    ['Service', b.service.name],
    ['Date', b.dateLabel],
    ['Slot', `${b.period.label} · ${b.timeLabel}`],
    ['Vehicle', b.vehicle],
    ['Handover', handoverLabel(b)],
    ['Phone', b.phone],
  ];
  $('[data-details]').replaceChildren(...details.map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: value || '—' }))));

  const timeline = b.timeline && b.timeline.length ? b.timeline : [{ type: 'created', label: 'Booking requested', at: b.createdAt }];
  $('[data-timeline]').replaceChildren(...timeline.map((t) => el('li', {},
    el('span', { class: `timeline-dot${ENDED_EVENTS.has(t.type) ? ' is-ended' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'timeline-text' }, el('span', { text: t.label }), el('time', { datetime: t.at, text: fmt.dateTime(t.at) })))));

  const calendar = $('[data-calendar]');
  calendar.hidden = cancelled || !b.calendarUrl;
  if (!calendar.hidden) {
    $('[data-cal-apple]').href = b.calendarUrl;
    $('[data-cal-outlook]').href = b.calendarUrl;
    $('[data-cal-google]').href = googleCalendarUrl(b);
  }

  renderChange();
}

function renderChange() {
  const b = state.booking;
  let step = 'closed';
  if (b.status === 'cancelled') step = 'cancelled';
  else if (b.canCancel) step = state.cancelStep;
  changeStates.forEach((n) => { n.hidden = n.dataset.change !== step; });

  $('[data-deadline]').textContent = fmt.dateTime(b.cancelDeadline);
  $('[data-confirm-text]').textContent = `Cancel your ${b.service.name} on ${fmt.short(b.date)}, ${b.period.label}? The slot will be released to other customers.`;
  $('[data-cancel-error]').textContent = '';
  $('[data-closed-text]').replaceChildren(...(ACTIVE.has(b.status)
    ? ['Online cancellation has closed for this booking. To change or cancel it, call ', phoneLink(), '.']
    : ['Questions about this booking? Call ', phoneLink(), '.']));
  $('[data-rebook]').href = `booking.html?service=${encodeURIComponent(b.service.code)}`;
}

// ---------- Find a booking ----------

function validate(reference, phone) {
  const errors = {};
  if (!normalizeRef(reference)) errors.reference = 'Tracking IDs look like SJP-K7Q4-9XZ2';
  if (phone.replace(/\D/g, '').length < 9) errors.phone = 'Enter the phone number you booked with';
  return errors;
}

form.addEventListener('input', (e) => { if (e.target.matches('input')) clearFieldError(e.target); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isBusy(submitBtn)) return;
  const refInput = form.elements.reference;
  const phone = form.elements.phone.value.trim();
  if (showFieldErrors(form, validate(refInput.value, phone))) return;

  const reference = normalizeRef(refInput.value);
  refInput.value = reference;
  setBusy(submitBtn, true);
  try {
    const { booking } = await api.track(reference, phone);
    state = { booking, phone, cancelStep: 'idle' };
    renderResult();
    show('result');
    history.replaceState(null, '', `?ref=${encodeURIComponent(booking.reference)}`);
    document.getElementById('result-ref').focus();
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      show('notfound');
      document.getElementById('notfound-title').focus();
    } else if (!(err.code === 'VALIDATION_FAILED' && showFieldErrors(form, err.fields))) {
      show('error');
      document.querySelector('[data-error-text]').textContent = err.message;
    }
  } finally {
    setBusy(submitBtn, false);
  }
});

// ---------- Cancel ----------

$('[data-ask-cancel]').addEventListener('click', () => {
  state.cancelStep = 'confirm';
  renderChange();
  $('[data-confirm-text]').focus();
});

$('[data-keep]').addEventListener('click', () => {
  state.cancelStep = 'idle';
  renderChange();
  $('[data-ask-cancel]').focus();
});

$('[data-do-cancel]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (isBusy(button)) return;
  const previous = state.booking;
  setBusy(button, true);
  try {
    const { booking } = await api.cancelTracked(previous.reference, state.phone, null);
    // The cancel response has no history, so carry the existing timeline forward.
    if (!booking.timeline) {
      booking.timeline = [...(previous.timeline || []), ...(booking.cancelledAt ? [{ type: 'cancelled', label: 'Booking cancelled', at: booking.cancelledAt }] : [])];
    }
    state.booking = booking;
    state.cancelStep = 'idle';
    renderResult();
    toast("Booking cancelled. We've sent a confirmation by text and email.");
    $('[data-cancelled-text]').focus();
  } catch (err) {
    if (err.code === 'CANCELLATION_CLOSED') {
      state.booking = { ...previous, canCancel: false };
      state.cancelStep = 'idle';
      renderChange();
      toast(err.message, { error: true });
      $('[data-closed-text]').focus();
    } else {
      $('[data-cancel-error]').textContent = err.message;
    }
  } finally {
    setBusy(button, false);
  }
});

// ---------- Start ----------

const refParam = param('ref');
if (refParam) {
  form.elements.reference.value = normalizeRef(refParam) || refParam.slice(0, 40);
  form.elements.phone.focus();
}

// Signed-in visitors can add the booking straight from My bookings.
currentUser().then((user) => {
  if (!user) return;
  $('[data-together-title]').textContent = 'Add it to your account';
  $('[data-together-text]').textContent = 'Add this booking to My bookings with its tracking ID and phone number, and see every valet in one place.';
  $('[data-together-link]').href = 'my-bookings.html';
  $('[data-together-label]').textContent = 'Go to My bookings';
});
