// My bookings: next valet, upcoming / past / cancelled lists, online cancellation, adding guest bookings and sign out.
import { api } from './api.js';
import { BUSINESS } from './config.js';
import { clearFieldError, currentUser, el, fmt, icon, ICONS, isoDate, parseDate, showFieldErrors, toast } from './ui.js';

const SIGN_IN = 'account.html?next=my-bookings.html';
const ACTIVE = new Set(['pending', 'confirmed']);
const ENDED_EVENTS = new Set(['cancelled', 'no_show']);
const PERIOD_ORDER = { morning: 0, afternoon: 1, evening: 2 };
const EMPTY = {
  upcoming: 'Nothing booked yet. Pick a slot and we will take care of the rest.',
  past: 'Your completed valets will show here.',
  cancelled: 'No cancelled bookings.',
};

const $ = (selector) => document.querySelector(selector);
const tabs = [...document.querySelectorAll('[role="tab"]')];
const tablist = $('[role="tablist"]');
const panel = $('#bookings-panel');
const list = $('[data-list]');
const claimForm = $('[data-claim]');

const state = {
  bookings: [],
  tab: 'upcoming',
  open: null, // reference of the expanded row
  confirming: null, // reference awaiting "Yes, cancel"
  history: new Map(), // reference → timeline array | 'loading' | 'failed'
};

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

function firstName(user) {
  return (user.fullName || '').trim().split(/\s+/)[0] || user.username;
}

function initials(user) {
  const words = (user.fullName || user.username || '').trim().split(/\s+/).filter(Boolean);
  return ((words[0] || '').charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : '')).toUpperCase();
}

function find(reference) {
  return state.bookings.find((b) => b.reference === reference);
}

/** Add a booking to the list, or replace it with a fresher copy. */
function upsert(booking) {
  const i = state.bookings.findIndex((b) => b.reference === booking.reference);
  if (i < 0) state.bookings.push(booking);
  else state.bookings[i] = booking;
}

function handleAuthError(err) {
  if (err.code !== 'UNAUTHENTICATED') return false;
  location.replace(SIGN_IN);
  return true;
}

// ---------- Grouping ----------

/** upcoming = still live and today or later; past = done, missed or a live booking whose day has gone; cancelled. */
function bucket(b, today) {
  if (b.status === 'cancelled') return 'cancelled';
  if (ACTIVE.has(b.status) && b.date >= today) return 'upcoming';
  return 'past';
}

const slotRank = (b) => PERIOD_ORDER[b.period.code] ?? 9;
const byWhen = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : slotRank(a) - slotRank(b));

function lists() {
  const today = isoDate(new Date());
  const out = { upcoming: [], past: [], cancelled: [] };
  state.bookings.forEach((b) => out[bucket(b, today)].push(b));
  out.upcoming.sort(byWhen);
  out.past.sort((a, b) => byWhen(b, a));
  out.cancelled.sort((a, b) => byWhen(b, a));
  return out;
}

function countdown(date) {
  const days = Math.round((parseDate(date) - parseDate(isoDate(new Date()))) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`;
}

function depositLabel(b) {
  const amount = euro(b.deposit.amountEur);
  switch (b.deposit.status) {
    case 'paid': return `${amount} paid`;
    case 'waived': return 'Waived';
    case 'refunded': return `${amount} refunded`;
    case 'requested': return `${amount} requested`;
    default: return ACTIVE.has(b.status) ? 'Requested after confirmation' : 'Not taken';
  }
}

function handoverLabel(b) {
  if (b.handover !== 'collection') return 'Drop off';
  return b.collectionAddress ? `Collection from ${b.collectionAddress}` : 'Collection';
}

// ---------- Rendering ----------

function render() {
  const groups = lists();
  const n = groups.upcoming.length;
  $('[data-summary]').textContent = n === 0
    ? 'No upcoming valets. Your car might be due a treat.'
    : n === 1 ? 'You have 1 upcoming valet.' : `You have ${n} upcoming valets.`;
  renderNext(groups.upcoming[0]);
  tabs.forEach((t) => {
    const on = t.dataset.tab === state.tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    t.querySelector('[data-count]').textContent = String(groups[t.dataset.tab].length);
  });
  panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  const items = groups[state.tab];
  const empty = $('[data-list-empty]');
  empty.hidden = items.length > 0;
  empty.textContent = EMPTY[state.tab];
  list.replaceChildren(...items.map(row));
}

function renderNext(b) {
  const card = $('[data-next]');
  card.hidden = !b;
  if (!b) return;
  $('[data-next-dow]').textContent = fmt.dow(b.date);
  $('[data-next-day]').textContent = String(parseDate(b.date).getDate()).padStart(2, '0');
  $('[data-next-mon]').textContent = fmt.monthShort(b.date);
  $('[data-next-countdown]').textContent = countdown(b.date);
  $('[data-next-service]').textContent = b.service.name;
  $('[data-next-meta]').replaceChildren(el('span', { class: 'sr-only', text: `${fmt.long(b.date)}, ` }), `${b.period.label} · ${b.timeLabel} · ${b.reference}`);
  const pill = $('[data-next-status]');
  pill.className = `pill pill-${b.status}`;
  pill.textContent = b.statusLabel;
  const calendar = $('[data-next-calendar]');
  calendar.hidden = !b.calendarUrl;
  if (b.calendarUrl) calendar.href = b.calendarUrl;
  $('[data-next-open]').dataset.ref = b.reference;
}

function row(b) {
  const isOpen = state.open === b.reference;
  const panelId = `details-${b.reference}`;
  const head = el('div', { class: 'row-head' },
    el('div', { class: 'date-tile-sm', 'aria-hidden': 'true' },
      el('span', { class: 'dt-dow', text: fmt.dow(b.date) }),
      el('span', { class: 'dt-day', text: String(parseDate(b.date).getDate()).padStart(2, '0') }),
      el('span', { class: 'dt-mon', text: fmt.monthShort(b.date) })),
    el('div', { class: 'row-info' },
      el('h3', { text: b.service.name }),
      el('p', { class: 'row-meta' }, el('span', { class: 'sr-only', text: `${fmt.long(b.date)}, ` }), `${b.period.label} · `, el('span', { class: 'nowrap', text: b.reference }))),
    el('span', { class: `pill pill-${b.status}`, text: b.statusLabel }),
    el('button', {
      class: 'icon-btn row-toggle', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': panelId,
      'aria-label': `Details for ${b.reference}`, dataset: { focus: 'toggle' }, onclick: () => toggleRow(b.reference),
    }, icon(ICONS.chevronDown, 16)));
  return el('li', { class: `booking-row${isOpen ? ' is-open' : ''}${b.status === 'cancelled' ? ' is-cancelled' : ''}`, dataset: { ref: b.reference } },
    head, rowPanel(b, panelId, isOpen));
}

function rowPanel(b, id, isOpen) {
  const active = ACTIVE.has(b.status);
  const facts = [['Vehicle', b.vehicle], ['Handover', handoverLabel(b)], ['Deposit', depositLabel(b)], ['Date', fmt.long(b.date)]];
  const actions = el('div', { class: 'row-actions' });
  if (active && b.calendarUrl) actions.append(el('a', { class: 'btn btn-ghost btn-sm', href: b.calendarUrl }, 'Add to calendar'));
  if (b.canCancel && state.confirming === b.reference) {
    actions.append(
      el('span', { class: 'row-confirm', tabindex: '-1', dataset: { focus: 'confirm' } }, 'Release this slot?',
        el('span', { class: 'sr-only', text: ` This cancels your ${b.service.name} on ${fmt.long(b.date)}.` })),
      el('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: (e) => cancelBooking(b.reference, e.currentTarget) }, 'Yes, cancel'),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { state.confirming = null; refreshRow(b.reference, 'ask'); } }, 'Keep'));
  } else if (b.canCancel) {
    actions.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', dataset: { focus: 'ask' }, onclick: () => { state.confirming = b.reference; refreshRow(b.reference, 'confirm'); } }, 'Cancel booking'));
  }
  if (!active) actions.append(el('a', { class: 'btn btn-gold btn-sm', href: `booking.html?service=${encodeURIComponent(b.service.code)}` }, 'Book again'));
  if (active && !b.canCancel) {
    actions.append(el('span', { class: 'row-note' }, 'Within 24 hours of your slot — call ', el('a', { href: BUSINESS.phoneHref, text: BUSINESS.phone }), ' to change it.'));
  }
  return el('div', { class: 'row-panel', id, hidden: !isOpen },
    el('dl', { class: 'facts' }, ...facts.map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: value || '—' })))),
    actions,
    historyBlock(b.reference));
}

function historyBlock(reference) {
  const timeline = state.history.get(reference);
  const block = el('div', { class: 'row-history', dataset: { history: '' } });
  if (timeline === 'loading') block.append(el('p', { class: 'row-note', text: 'Loading history…' }));
  else if (Array.isArray(timeline) && timeline.length) {
    block.append(el('h4', { class: 'panel-title', text: 'History' }), el('ol', { class: 'timeline' }, ...timeline.map((t) => el('li', {},
      el('span', { class: `timeline-dot${ENDED_EVENTS.has(t.type) ? ' is-ended' : ''}`, 'aria-hidden': 'true' }),
      el('span', { class: 'timeline-text' }, el('span', { text: t.label }), el('time', { datetime: t.at, text: fmt.dateTime(t.at) }))))));
  } else block.hidden = true;
  return block;
}

/** Re-render one row in place, putting focus back on the matching control (data-focus key). */
function refreshRow(reference, focusKey) {
  const old = list.querySelector(`[data-ref="${CSS.escape(reference)}"]`);
  const booking = find(reference);
  if (!old || !booking) return;
  const active = document.activeElement;
  const key = focusKey || (old.contains(active) && active.dataset.focus) || null;
  const fresh = row(booking);
  old.replaceWith(fresh);
  if (key) {
    const target = fresh.querySelector(`[data-focus="${key}"]`) || fresh.querySelector('[data-focus="toggle"]');
    target.focus();
  }
}

function toggleRow(reference) {
  const previous = state.open;
  state.open = previous === reference ? null : reference;
  state.confirming = null;
  if (previous && previous !== reference) refreshRow(previous);
  refreshRow(reference, 'toggle');
  if (state.open) loadHistory(reference);
}

/** Fetch a booking's history the first time it is expanded. */
async function loadHistory(reference) {
  if (state.history.has(reference)) return;
  state.history.set(reference, 'loading');
  const swap = () => {
    const slot = list.querySelector(`[data-ref="${CSS.escape(reference)}"] [data-history]`);
    if (slot) slot.replaceWith(historyBlock(reference));
  };
  swap();
  try {
    const { booking } = await api.myBooking(reference);
    state.history.set(reference, booking.timeline || []);
  } catch (err) {
    if (handleAuthError(err)) return;
    state.history.delete(reference); // try again next time it opens
  }
  swap();
}

// ---------- Tabs ----------

function selectTab(name) {
  state.tab = name;
  state.open = null;
  state.confirming = null;
  render();
  tabs.find((t) => t.dataset.tab === name).focus();
}
tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
tablist.addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  selectTab(tabs[(to + tabs.length) % tabs.length].dataset.tab);
});

$('[data-next-open]').addEventListener('click', (e) => {
  const reference = e.currentTarget.dataset.ref;
  state.tab = 'upcoming';
  state.open = reference;
  state.confirming = null;
  render();
  loadHistory(reference);
  const toggle = list.querySelector(`[data-ref="${CSS.escape(reference)}"] .row-toggle`);
  if (toggle) toggle.focus();
});

// ---------- Cancel ----------

async function cancelBooking(reference, button) {
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    const { booking } = await api.cancelMine(reference, null);
    upsert(booking);
    state.confirming = null;
    state.history.delete(reference);
    render();
    toast(`${reference} cancelled. We've sent a confirmation by text and email.`);
    tabs.find((t) => t.dataset.tab === state.tab).focus();
  } catch (err) {
    if (handleAuthError(err)) return;
    if (err.code === 'CANCELLATION_CLOSED') {
      upsert({ ...find(reference), canCancel: false });
      state.confirming = null;
      refreshRow(reference, 'toggle');
    }
    toast(err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
}

// ---------- Add a guest booking ----------

function setClaimMessage(message, ok = false) {
  const msg = $('[data-claim-msg]');
  msg.textContent = message;
  msg.classList.toggle('is-ok', ok);
}

claimForm.addEventListener('input', (e) => {
  if (!e.target.matches('input')) return;
  clearFieldError(e.target);
  setClaimMessage('');
});

claimForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = claimForm.querySelector('[type="submit"]');
  if (isBusy(button)) return;
  const reference = normalizeRef(claimForm.elements.reference.value);
  const phone = claimForm.elements.phone.value.trim();
  // One message line under the form (per the design); showFieldErrors marks and focuses the field.
  const errors = {};
  if (!reference) errors.reference = 'Tracking IDs look like SJP-K7Q4-9XZ2.';
  else if (phone.replace(/\D/g, '').length < 9) errors.phone = 'Enter the phone number you booked with.';
  setClaimMessage(Object.values(errors)[0] || '');
  if (showFieldErrors(claimForm, errors)) return;
  claimForm.elements.reference.value = reference;
  if (find(reference)) {
    setClaimMessage('That booking is already in your account.', true);
    return;
  }
  setBusy(button, true);
  try {
    const { booking } = await api.claim(reference, phone);
    upsert(booking);
    claimForm.reset();
    state.tab = bucket(booking, isoDate(new Date()));
    state.open = booking.reference;
    state.confirming = null;
    state.history.delete(booking.reference);
    render();
    loadHistory(booking.reference);
    setClaimMessage(`${booking.reference} added to your account.`, true);
  } catch (err) {
    if (handleAuthError(err)) return;
    if (err.code === 'VALIDATION_FAILED' && showFieldErrors(claimForm, err.fields)) setClaimMessage(Object.values(err.fields)[0]);
    else setClaimMessage(err.message);
  } finally {
    setBusy(button, false);
  }
});

// ---------- Sign out ----------

$('[data-sign-out]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    await api.logout();
    $('[data-signed-in]').hidden = true;
    $('[data-user-chip]').hidden = true;
    const signedOut = $('[data-signed-out]');
    signedOut.hidden = false;
    document.title = 'Signed out · St Johns Park Car Valeting';
    signedOut.querySelector('h1').focus();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
});

// ---------- Start ----------

function fillUser(user) {
  document.querySelectorAll('[data-user]').forEach((n) => { n.textContent = user[n.dataset.user] || '—'; });
  $('[data-initials]').textContent = initials(user);
  const hour = new Date().getHours();
  $('[data-greeting]').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('[data-first-name]').textContent = `${firstName(user)}.`;
}

async function loadBookings() {
  const loading = $('[data-list-loading]');
  const error = $('[data-list-error]');
  loading.hidden = false;
  error.hidden = true;
  try {
    const { bookings } = await api.myBookings();
    state.bookings = bookings;
    render();
  } catch (err) {
    if (handleAuthError(err)) return;
    error.hidden = false;
    $('[data-list-error-text]').textContent = err.message;
    $('[data-summary]').textContent = "We couldn't load your bookings just now.";
  } finally {
    loading.hidden = true;
  }
}
$('[data-retry]').addEventListener('click', loadBookings);

async function init() {
  const user = await currentUser();
  if (!user) {
    location.replace(SIGN_IN);
    return;
  }
  fillUser(user);
  $('[data-loading]').hidden = true;
  $('[data-signed-in]').hidden = false;
  $('[data-user-chip]').hidden = false;
  await loadBookings();
}
init();
