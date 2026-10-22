// Booking page: choose a service, pick a free slot from live availability, then send the booking.
import { api, ApiError, newIdempotencyKey } from './api.js';
import { BUSINESS } from './config.js';
import { addDays, clearFieldError, currentUser, el, fmt, icon, ICONS, isoDate, mondayOf, param, parseDate, showFieldErrors } from './ui.js';

const $ = (selector) => document.querySelector(selector);

const PERIOD_ICONS = {
  morning: ['M17 18a5 5 0 0 0-10 0', 'M12 2v7M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1M8 6l4-4 4 4'],
  afternoon: ['M7.5 12a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0', 'M12 1.5v2.5M12 20v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M1.5 12H4M20 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8'],
  evening: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
};
const SLOT_REASONS = {
  too_soon: 'Too soon to book online',
  blocked: 'Not available',
  closed: 'Closed',
  past: 'In the past',
  beyond_window: 'Not yet open for booking',
};
const HANDOVER_LABELS = { drop_off: 'Drop off at St Johns Park', collection: 'Vehicle collection' };
const FORM_FIELDS = ['name', 'phone', 'email', 'vehicle', 'collectionAddress', 'notes', 'discountCode', 'vehicleSize', 'addons'];
const GENERIC_ERROR = `Something went wrong. Please try again, or call ${BUSINESS.phone}.`;

// ---------- Elements ----------
const form = $('#booking-form');
const inputs = Object.fromEntries(FORM_FIELDS.map((name) => [name, form.querySelector(`[name="${name}"]`)]));
const loadError = $('[data-load-error]');
const servicesEl = $('[data-services]');
const monthEl = $('[data-month]');
const thisWeekBtn = $('[data-this-week]');
const prevBtn = $('[data-prev-week]');
const nextBtn = $('[data-next-week]');
const weekEl = $('[data-week]');
const weekError = $('[data-week-error]');
const slotsEl = $('[data-slots]');
const slotError = $('[data-slot-error]');
const noneFree = $('[data-none-free]');
const dayFull = $('[data-day-full]');
const jumpBtn = $('[data-jump-next]');
const addressField = $('[data-address-field]');
const handoverBtns = [...document.querySelectorAll('[data-handover]')];
const confirmBtn = $('[data-confirm]');
const hintEl = $('[data-hint]');
const submitError = $('[data-submit-error]');
const doneEl = $('[data-done]');
const pausedEl = $('[data-paused]');
const sizesWrap = $('[data-sizes-wrap]');
const sizesEl = $('[data-sizes]');
const extrasWrap = $('[data-extras-wrap]');
const extrasEl = $('[data-extras]');
const discountBtn = $('[data-discount-apply]');
const discountStatus = $('[data-discount-status]');
const priceEl = $('[data-price]');

// ---------- State ----------
const state = {
  config: null,
  user: null,
  today: isoDate(new Date()), // replaced by the server's "today" once availability arrives
  lastBookable: null,
  weekStart: null,
  date: null,
  period: null,
  service: null,
  size: null,
  addons: new Set(),
  discount: null, // a valid /discounts/check result plus `key` (the service|size it was checked for)
  discountTried: null, // the code last sent to /discounts/check, re-checked when the service or size changes
  handover: 'drop_off',
  searching: false,
  searchError: null,
  noneFree: false,
  navigated: false,
  submitting: false,
  idempotencyKey: null,
  booking: null,
};
const weekData = new Map(); // Monday → DayView[]
const weekLoads = new Map(); // Monday → in-flight request
const weekErrors = new Map(); // Monday → message
const mine = new Set(); // 'date|period' booked in this visit, shown as "Yours"
let nextAvail = { from: null, date: undefined, failed: false };

// ---------- Small helpers ----------
const euro = (amount) => `€${Number.isInteger(amount) ? amount : Number(amount).toFixed(2)}`;
const businessPhone = () => (state.config && state.config.business && state.config.business.phone) || BUSINESS.phone;
const businessAddress = () => (state.config && state.config.business && state.config.business.address) || BUSINESS.address;
const depositEur = () => (state.config && state.config.booking ? state.config.booking.depositAmountEur : null);
const lastBookable = () => state.lastBookable || addDays(state.today, state.config.booking.maxDaysAhead);
const errorMessage = (err) => (err instanceof ApiError ? err.message : GENERIC_ERROR);
const bySize = () => Boolean(state.config && state.config.booking && state.config.booking.pricesBySize);
const sizeLabel = (code) => ((state.config.booking.vehicleSizes || []).find((v) => v.code === code) || {}).label || '';
const discountKey = () => `${state.service}|${state.size || ''}`;
let discountSeq = 0;

/** { priceEur, salePriceEur } for a service: the chosen size's price, or the base price until a size is picked. */
function servicePrice(s, size = state.size) {
  if (bySize() && size && s.prices && s.prices[size]) return s.prices[size];
  return { priceEur: s.priceEur, salePriceEur: s.salePriceEur };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** Swap a container's children and keep keyboard focus on the matching new element. */
function replaceKeepingFocus(container, nodes) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.key : null;
  container.replaceChildren(...nodes);
  if (key) {
    const again = container.querySelector(`[data-key="${key}"]`);
    if (again && !again.disabled) again.focus();
  }
}

function slotIcon(period, size = 26) {
  const svg = icon(PERIOD_ICONS[period] || PERIOD_ICONS.afternoon, size);
  svg.setAttribute('stroke-width', '1.4');
  return svg;
}

function slotTime(slot) {
  const period = (state.config.periods || []).find((p) => p.code === slot.period) || slot;
  if (period.startTime && period.endTime) return `${period.startTime}–${period.endTime}`;
  return period.startTime || 'Time to be confirmed';
}

function monthLabel(monday) {
  const sunday = addDays(monday, 6);
  if (monday.slice(0, 7) === sunday.slice(0, 7)) return fmt.monthYear(monday);
  const startYear = monday.slice(0, 4) === sunday.slice(0, 4) ? '' : ` ${monday.slice(0, 4)}`;
  return `${fmt.monthShort(monday)}${startYear} – ${fmt.monthShort(sunday)} ${sunday.slice(0, 4)}`;
}

// ---------- Availability (cached per Monday–Sunday week) ----------
function loadWeek(monday) {
  if (weekData.has(monday)) return Promise.resolve(weekData.get(monday));
  if (weekLoads.has(monday)) return weekLoads.get(monday);
  weekErrors.delete(monday);
  const load = api.availability(monday, addDays(monday, 6)).then(
    (res) => {
      if (weekLoads.get(monday) !== load) return res.days; // superseded by a refetch
      weekLoads.delete(monday);
      state.today = res.today;
      state.lastBookable = res.lastBookableDate;
      weekData.set(monday, res.days);
      return res.days;
    },
    (err) => {
      if (weekLoads.get(monday) === load) {
        weekLoads.delete(monday);
        weekErrors.set(monday, errorMessage(err));
      }
      throw err;
    },
  );
  weekLoads.set(monday, load);
  return load;
}

function invalidateWeek(monday) {
  weekData.delete(monday);
  weekLoads.delete(monday);
  weekErrors.delete(monday);
}

function getDay(date) {
  const days = weekData.get(mondayOf(date));
  return days ? days.find((d) => d.date === date) : null;
}

/** First date on or after `from` with a free slot, searching week by week up to the booking window. */
async function findFirstAvailable(from) {
  for (let monday = mondayOf(from); monday <= lastBookable(); monday = addDays(monday, 7)) {
    const days = await loadWeek(monday);
    const day = days.find((d) => d.date >= from && d.open && d.available > 0);
    if (day) return day.date;
  }
  return null;
}

function lookupNextAvailable(date) {
  nextAvail = { from: date, date: undefined, failed: false };
  findFirstAvailable(addDays(date, 1)).then(
    (found) => { if (nextAvail.from === date) { nextAvail.date = found; render(); } },
    () => { if (nextAvail.from === date) { nextAvail.date = null; nextAvail.failed = true; render(); } },
  );
}

async function pickFirstDate() {
  state.searching = true;
  state.searchError = null;
  render();
  try {
    const first = await findFirstAvailable(state.today);
    if (!state.date) {
      if (first) {
        state.date = first;
        if (!state.navigated) state.weekStart = mondayOf(first);
      } else {
        state.noneFree = true;
      }
    }
  } catch (err) {
    // Shown above the week strip with a retry button.
    if (!state.date) state.searchError = errorMessage(err);
  }
  state.searching = false;
  render();
}

// ---------- Selection ----------
function selectedService() {
  return (state.config.services || []).find((s) => s.code === state.service) || null;
}

function selectedSlot() {
  if (!state.date || !state.period) return null;
  const day = getDay(state.date);
  const slot = day && day.slots.find((s) => s.period === state.period);
  return slot && slot.status === 'available' ? slot : null;
}

function detailsGap() {
  const value = (name) => inputs[name].value.trim();
  if (!value('name') || !value('phone')) return 'Add your name and phone number';
  if (!value('vehicle')) return 'Add your vehicle — make, model & colour';
  if (state.handover === 'collection' && !value('collectionAddress')) return 'Add the collection address';
  return '';
}

function selectService(code) {
  state.service = code;
  render();
  recheckDiscount();
}

function selectSize(code) {
  state.size = code;
  clearFieldError(form.querySelector('[name="vehicleSize"]'));
  render();
  recheckDiscount();
}

function toggleAddon(id, on) {
  if (on) state.addons.add(id);
  else state.addons.delete(id);
  clearFieldError(form.querySelector('[name="addons"]'));
  renderSummary();
}

// ---------- Discount code ----------
function setDiscountStatus(text, kind = '') {
  setText(discountStatus, text);
  discountStatus.classList.toggle('is-ok', kind === 'ok');
  discountStatus.classList.toggle('is-bad', kind === 'bad');
}

/** Checks the code against the chosen service (and size) without using it up; the booking itself re-checks it. */
async function applyDiscount() {
  const code = inputs.discountCode.value.trim();
  clearFieldError(inputs.discountCode);
  state.discount = null;
  state.discountTried = code || null;
  if (!code) {
    setDiscountStatus('');
    renderSummary();
    return;
  }
  if (!state.service) {
    setDiscountStatus('Choose a service first, then apply the code.', 'bad');
    renderSummary();
    return;
  }
  const seq = ++discountSeq;
  const key = discountKey();
  discountBtn.disabled = true;
  setDiscountStatus('Checking…');
  try {
    const res = await api.checkDiscount(code, state.service, bySize() ? state.size : null);
    if (seq !== discountSeq) return;
    if (res.valid) {
      state.discount = { ...res, key };
      setDiscountStatus(`${res.code} applied · ${res.label} (−${euro(res.discountEur)})`, 'ok');
    } else {
      setDiscountStatus(res.message, 'bad');
    }
  } catch (err) {
    if (seq === discountSeq) setDiscountStatus(errorMessage(err), 'bad');
  } finally {
    if (seq === discountSeq) {
      discountBtn.disabled = false;
      renderSummary();
    }
  }
}

function recheckDiscount() {
  if (state.discountTried && inputs.discountCode.value.trim() === state.discountTried) applyDiscount();
}

function selectDate(date) {
  if (date !== state.date) {
    state.date = date;
    state.period = null;
  }
  slotError.hidden = true;
  render();
}

function selectSlot(period) {
  // "Picked a slot" step of the admin analytics funnel (only sent once the visitor has allowed analytics).
  if (state.period !== period) window.sjpTrack?.('select_slot', { slot_period: period });
  state.period = period;
  slotError.hidden = true;
  render();
}

function goToWeek(monday) {
  state.weekStart = monday;
  state.navigated = true;
  weekErrors.delete(monday);
  render();
}

// ---------- Rendering ----------
function render() {
  if (!state.config || !state.weekStart) return;
  const day = state.date && state.period ? getDay(state.date) : null;
  const slot = day && day.slots.find((s) => s.period === state.period);
  if (slot && slot.status !== 'available') state.period = null;
  renderServices();
  renderSizes();
  renderWeek();
  renderSlots();
  renderHandover();
  renderSummary();
}

function buildServices() {
  const services = state.config.services || [];
  if (!services.length) {
    servicesEl.replaceChildren(el('p', { class: 'small muted', text: `Online booking is paused right now. Please call us on ${businessPhone()}.` }));
    return;
  }
  servicesEl.replaceChildren(...services.map((s) => {
    const check = icon(ICONS.check, 18);
    check.classList.add('bk-service-check');
    check.setAttribute('stroke-width', '2');
    const onSale = s.salePriceEur !== null && s.salePriceEur !== undefined;
    const from = s.priceFrom || bySize() ? 'From ' : '';
    const tags = [
      s.featured ? el('span', { class: 'bk-tag', text: 'Signature' }) : null,
      onSale ? el('span', { class: 'bk-tag bk-tag-sale', text: s.saleEndsOn ? `Sale until ${fmt.short(s.saleEndsOn)}` : 'Sale' }) : null,
    ].filter(Boolean);
    return el('button', { type: 'button', class: 'choice bk-service', 'aria-pressed': 'false', 'data-key': s.code, onclick: () => selectService(s.code) },
      el('span', { class: 'bk-service-top' }, el('span', { class: 'bk-service-name', text: s.name }), check),
      tags.length ? el('span', { class: 'bk-service-tags' }, tags) : null,
      s.durationLabel ? el('span', { class: 'bk-service-duration', text: s.durationLabel }) : null,
      s.priceEur === null || s.priceEur === undefined ? null
        : onSale
          ? el('span', { class: 'bk-service-price' }, from,
            el('s', {}, el('span', { class: 'sr-only', text: 'was ' }), euro(s.priceEur)),
            el('span', { class: 'bk-sale' }, el('span', { class: 'sr-only', text: 'now ' }), euro(s.salePriceEur)))
          : el('span', { class: 'bk-service-price', text: `${from}${euro(s.priceEur)}` }));
  }));
}

function renderServices() {
  servicesEl.querySelectorAll('[data-key]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === state.service)));
}

function buildSizes() {
  sizesWrap.hidden = !bySize();
  if (!bySize()) return;
  sizesEl.replaceChildren(...state.config.booking.vehicleSizes.map((v) => el('button', {
    type: 'button', class: 'choice bk-size-opt', 'aria-pressed': 'false', 'data-key': v.code, onclick: () => selectSize(v.code),
  }, el('span', { class: 'bk-size-name', text: v.label }), el('span', { class: 'bk-size-price', 'data-size-price': '' }))));
}

/** Pressed state, plus each size's price for the chosen service. */
function renderSizes() {
  if (!bySize()) return;
  const service = selectedService();
  form.querySelector('[name="vehicleSize"]').value = state.size || '';
  sizesEl.querySelectorAll('[data-key]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.key === state.size));
    const p = service ? servicePrice(service, b.dataset.key) : null;
    const amount = p && p.priceEur !== null && p.priceEur !== undefined ? p.salePriceEur ?? p.priceEur : null;
    setText(b.querySelector('[data-size-price]'), amount === null ? '' : `${service.priceFrom ? 'From ' : ''}${euro(amount)}`);
  });
}

function buildExtras() {
  const addons = state.config.addons || [];
  extrasWrap.hidden = !addons.length;
  extrasEl.replaceChildren(...addons.map((a) => {
    const box = el('input', { type: 'checkbox', value: a.id });
    box.checked = state.addons.has(a.id);
    box.addEventListener('change', () => toggleAddon(a.id, box.checked));
    return el('label', { class: 'bk-extra' }, box, el('span', { class: 'bk-extra-name', text: a.name }), el('span', { class: 'bk-extra-price', text: `+${euro(a.priceEur)}` }));
  }));
}

function renderWeek() {
  const monday = state.weekStart;
  setText(monthEl, monthLabel(monday));
  prevBtn.disabled = monday <= mondayOf(state.today);
  nextBtn.disabled = addDays(monday, 7) > lastBookable();

  if (!weekData.has(monday) && !weekLoads.has(monday) && !weekErrors.has(monday)) loadWeek(monday).then(render, render);
  const days = weekData.get(monday);
  const error = weekErrors.get(monday);
  const notice = error || (!state.date && state.searchError);
  weekEl.setAttribute('aria-busy', String(!days && !error));
  weekError.hidden = !notice;
  if (notice) setText(weekError.querySelector('[data-week-error-text]'), notice);

  const cards = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    cards.push(dayCard(date, days ? days.find((d) => d.date === date) : null, Boolean(error)));
  }
  replaceKeepingFocus(weekEl, cards);

  // Warm the cache so "next week" opens instantly.
  const following = addDays(monday, 7);
  if (days && following <= lastBookable() && !weekData.has(following) && !weekLoads.has(following) && !weekErrors.has(following)) {
    loadWeek(following).catch(() => {});
  }
}

function dayCard(date, day, failed) {
  const selected = date === state.date;
  const classes = ['bk-day'];
  if (date === state.today) classes.push('is-today');
  let status;
  let spoken;
  let disabled = true;
  let dots;

  if (!day) {
    classes.push(failed ? 'is-error' : 'is-pending');
    status = failed ? '—' : 'Loading';
    spoken = failed ? 'availability unavailable' : 'loading';
    dots = (state.config.periods || []).map(() => el('span', { class: 'bk-dot' }));
  } else {
    const bookable = day.slots.filter((s) => s.reason !== 'closed').length;
    const free = day.available;
    dots = day.slots.map((s) => el('span', { class: `bk-dot${day.open && s.status === 'available' ? ' is-free' : ''}` }));
    if (!day.open) {
      if (day.reason === 'past') { status = 'Past'; spoken = 'in the past'; }
      else if (day.reason === 'beyond_window') { status = 'Not yet'; spoken = 'not yet open for booking'; }
      else if (day.reason === 'blocked') { status = 'Closed'; spoken = 'not available'; }
      else { status = 'Closed'; spoken = 'closed'; }
    } else {
      disabled = false;
      if (free === 0) {
        const booked = day.slots.some((s) => s.status === 'booked');
        classes.push('is-full');
        status = booked ? 'Full' : 'No slots';
        spoken = booked ? 'fully booked' : 'no slots left to book online';
      } else {
        classes.push('has-free');
        status = free === bookable ? `${free} free` : `${free} left`;
        spoken = `${free} of ${bookable} slots free`;
      }
    }
  }

  return el('button', {
    type: 'button',
    class: classes.join(' '),
    'aria-pressed': String(selected),
    'aria-label': `${fmt.long(date)}, ${spoken}`,
    disabled,
    'data-key': date,
    onclick: () => selectDate(date),
  },
  el('span', { class: 'bk-day-dow', text: date === state.today ? 'Today' : fmt.dow(date) }),
  el('span', { class: 'bk-day-num', text: String(parseDate(date).getDate()).padStart(2, '0') }),
  el('span', { class: 'bk-day-month', text: fmt.monthShort(date) }),
  el('span', { class: 'bk-dots', 'aria-hidden': 'true' }, dots),
  el('span', { class: 'bk-day-status', text: status }));
}

function renderSlots() {
  setText($('[data-slots-for]'), state.date ? fmt.long(state.date) : '—');
  const day = state.date ? getDay(state.date) : null;
  if (state.date && !day) {
    const monday = mondayOf(state.date);
    if (!weekData.has(monday) && !weekLoads.has(monday) && !weekErrors.has(monday)) loadWeek(monday).then(render, render);
  }
  const loading = !day && (state.searching || Boolean(state.date && weekLoads.has(mondayOf(state.date))));
  let cards = [];
  if (day) {
    cards = day.slots.map(slotCard);
  } else if (loading) {
    cards = (state.config.periods || []).map((p) => slotCard({ ...p, period: p.code, status: 'pending' }));
  }
  slotsEl.hidden = cards.length === 0;
  slotsEl.setAttribute('aria-busy', String(loading));
  replaceKeepingFocus(slotsEl, cards);

  noneFree.hidden = !(state.noneFree && !state.date);
  if (!noneFree.hidden) {
    setText(noneFree, `Every online slot up to ${fmt.long(lastBookable())} is taken. Call us on ${businessPhone()} — we can often fit you in.`);
  }

  const full = Boolean(day && day.open && day.available === 0);
  dayFull.hidden = !full;
  if (full) renderDayFull(day);
}

function slotCard(slot) {
  const time = slotTime(slot);
  const selected = slot.status === 'available' && slot.period === state.period;
  let kind = slot.status;
  let tag;
  let spoken;
  let reason = null;

  if (slot.status === 'pending') {
    tag = el('span', { class: 'bk-slot-tag is-muted', text: 'Checking…' });
    spoken = 'checking availability';
  } else if (slot.status === 'booked') {
    const yours = mine.has(`${state.date}|${slot.period}`);
    tag = el('span', { class: 'bk-slot-tag is-booked' }, icon(ICONS.lock, 12), yours ? 'Yours' : 'Booked');
    spoken = yours ? 'booked by you' : 'already booked';
  } else if (slot.status === 'unavailable') {
    reason = SLOT_REASONS[slot.reason] || SLOT_REASONS.blocked;
    tag = el('span', { class: 'bk-slot-tag is-muted', text: 'Unavailable' });
    spoken = reason.toLowerCase();
  } else if (selected) {
    kind = 'selected';
    const check = icon(ICONS.check, 12);
    check.setAttribute('stroke-width', '2.6');
    tag = el('span', { class: 'bk-slot-tag is-selected' }, check, 'Selected');
    spoken = 'selected';
  } else {
    tag = el('span', { class: 'bk-slot-tag', text: 'Available' });
    spoken = 'available';
  }

  return el('button', {
    type: 'button',
    class: `bk-slot is-${kind}`,
    'aria-pressed': String(selected),
    'aria-label': `${slot.label} slot, ${time}, ${spoken}`,
    disabled: slot.status !== 'available',
    'data-key': slot.period,
    onclick: () => selectSlot(slot.period),
  },
  el('span', { class: 'bk-slot-top' }, el('span', { class: 'bk-slot-icon' }, slotIcon(slot.period)), tag),
  el('span', { class: 'bk-slot-name', text: slot.label }),
  el('span', { class: 'bk-slot-time', text: time }),
  reason ? el('span', { class: 'bk-slot-reason', text: reason }) : null);
}

function renderDayFull(day) {
  const booked = day.slots.some((s) => s.status === 'booked');
  const lead = booked ? 'This day is fully booked.' : 'There are no slots left to book online on this day.';
  if (nextAvail.from !== day.date) lookupNextAvailable(day.date);
  const text = dayFull.querySelector('[data-day-full-text]');
  if (nextAvail.date === null) {
    const after = nextAvail.failed ? "We couldn't check other dates just now" : 'No other free slots online right now';
    setText(text, `${lead} ${after} — call ${businessPhone()}.`);
    jumpBtn.hidden = true;
    return;
  }
  setText(text, lead);
  jumpBtn.hidden = false;
  jumpBtn.disabled = nextAvail.date === undefined;
  setText(jumpBtn, nextAvail.date ? `Next available · ${fmt.short(nextAvail.date)}` : 'Finding next available…');
}

function renderHandover() {
  handoverBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.handover === state.handover)));
  addressField.hidden = state.handover !== 'collection';
}

function setStep(n, done) {
  $(`[data-step-num="${n}"]`).classList.toggle('is-done', done);
}

function setMeta(n, text, isSet) {
  const meta = $(`[data-step-meta="${n}"]`);
  setText(meta, text);
  meta.classList.toggle('is-set', isSet);
}

function setSummary(name, text, empty) {
  const node = $(`[data-sum-${name}]`);
  setText(node, text);
  node.classList.toggle('is-empty', empty);
}

function renderSummary() {
  if (!state.config) return;
  const service = selectedService();
  const slot = selectedSlot();
  const gapInDetails = detailsGap();
  const needsSize = bySize() && !state.size;
  const serviceText = service ? `${service.name}${bySize() && state.size ? ` · ${sizeLabel(state.size)}` : ''}` : '';
  setStep(1, Boolean(service) && !needsSize);
  setStep(2, Boolean(slot));
  setStep(3, !gapInDetails);
  setMeta(1, service ? serviceText : 'Required', Boolean(service) && !needsSize);
  setMeta(2, slot ? `${fmt.short(state.date)} · ${slot.label}` : 'Required', Boolean(slot));
  if (state.booking) return; // the summary now describes the confirmed booking

  setSummary('service', service ? serviceText : 'Not selected', !service);
  setSummary('date', state.date ? fmt.long(state.date) : 'Not selected', !state.date);
  setSummary('slot', slot ? `${slot.label} · ${slotTime(slot)}` : 'Not selected', !slot);
  setSummary('handover', HANDOVER_LABELS[state.handover], false);
  renderPrice(service);

  const gap = !service ? 'Choose a service to continue' : needsSize ? 'Choose your vehicle size' : !slot ? 'Pick a free slot' : gapInDetails;
  confirmBtn.disabled = Boolean(gap);
  setText(hintEl, gap || 'Ready — no payment is taken now');
  hintEl.classList.toggle('is-ready', !gap);
}

/** Service (at the chosen size, sale price if live) + extras − a checked discount code. */
function renderPrice(service) {
  const p = service ? servicePrice(service) : null;
  if (!p || p.priceEur === null || p.priceEur === undefined) {
    priceEl.hidden = true;
    return;
  }
  const onSale = p.salePriceEur !== null && p.salePriceEur !== undefined;
  const base = onSale ? p.salePriceEur : p.priceEur;
  const extras = (state.config.addons || []).filter((a) => state.addons.has(a.id));
  const discount = state.discount && state.discount.key === discountKey() ? state.discount : null;
  const rows = [
    [`${service.name}${bySize() && state.size ? ` · ${sizeLabel(state.size)}` : ''}`, onSale ? `${euro(base)} (was ${euro(p.priceEur)})` : euro(base)],
    ...extras.map((a) => [a.name, `+${euro(a.priceEur)}`]),
    discount ? [`Code ${discount.code}`, `−${euro(discount.discountEur)}`, 'is-discount'] : null,
  ].filter(Boolean);
  $('[data-price-list]').replaceChildren(...rows.map(([label, value, cls]) => el('div', { class: cls }, el('dt', { text: label }), el('dd', { text: value }))));
  const total = Math.round((base + extras.reduce((t, a) => t + a.priceEur, 0) - (discount ? discount.discountEur : 0)) * 100) / 100;
  const from = service.priceFrom || (bySize() && !state.size);
  setText($('[data-price-total-label]'), from ? 'Estimated total' : 'Total');
  setText($('[data-price-total]'), `${from ? 'From ' : ''}${euro(Math.max(0, total))}`);
  $('[data-price-note]').hidden = !service.priceFrom;
  priceEl.hidden = false;
}

// ---------- Submit ----------
function setSubmitting(on) {
  state.submitting = on;
  form.inert = on;
  form.classList.toggle('is-loading', on);
  confirmBtn.setAttribute('aria-busy', String(on));
  confirmBtn.replaceChildren(...(on ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Confirming…'] : ['Confirm booking']));
}

function showSubmitError(message) {
  submitError.textContent = message;
  submitError.hidden = false;
}

/** Someone else took the slot (or it closed): say so beside the slots and show fresh availability. */
function slotTaken(message) {
  const monday = mondayOf(state.date);
  state.period = null;
  state.weekStart = monday;
  invalidateWeek(monday);
  nextAvail = { from: null, date: undefined, failed: false };
  slotError.textContent = message;
  slotError.hidden = false;
  render();
  slotError.focus();
}

/** The owner has paused online booking (Settings in the dashboard): say so and point to the phone. */
function showPaused(message) {
  setText(pausedEl.querySelector('[data-paused-text]'), message || `Please call us on ${businessPhone()} and we'll find you a slot.`);
  setText(pausedEl.querySelector('[data-paused-call]'), `Call ${businessPhone()}`);
  pausedEl.hidden = false;
  form.hidden = true;
  $('.bk-summary').hidden = true;
}

function handleSubmitError(err) {
  const error = err instanceof ApiError ? err : new ApiError(0, 'CLIENT', GENERIC_ERROR);
  if (error.code === 'SLOT_UNAVAILABLE') {
    slotTaken(error.message);
    return;
  }
  if (error.code === 'BOOKING_PAUSED') {
    showPaused(error.message);
    pausedEl.scrollIntoView({ block: 'start' });
    return;
  }
  if (error.code === 'VALIDATION_FAILED') {
    const entries = Object.entries(error.fields || {});
    const onForm = Object.fromEntries(entries.filter(([key]) => FORM_FIELDS.includes(key)));
    const elsewhere = entries.filter(([key]) => !FORM_FIELDS.includes(key)).map(([, message]) => message);
    const shown = showFieldErrors(form, onForm);
    if (!shown || elsewhere.length) showSubmitError(elsewhere.length ? elsewhere.join(' ') : error.message);
    if (!shown) confirmBtn.focus();
    return;
  }
  showSubmitError(error.message);
  confirmBtn.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const service = selectedService();
  const slot = selectedSlot();
  if (state.submitting || state.booking || !service || !slot || detailsGap() || (bySize() && !state.size)) return;

  const value = (name) => inputs[name].value.trim();
  const body = {
    serviceCode: service.code,
    date: state.date,
    period: slot.period,
    name: value('name'),
    phone: value('phone'),
    email: value('email') || null,
    vehicle: value('vehicle'),
    handover: state.handover,
    collectionAddress: state.handover === 'collection' ? value('collectionAddress') : null,
    notes: value('notes') || null,
    vehicleSize: bySize() ? state.size : null,
    addons: [...state.addons],
    discountCode: value('discountCode') || null,
  };
  // One key per booking attempt: a retry after a dropped connection can never create a second booking.
  state.idempotencyKey = state.idempotencyKey || newIdempotencyKey();
  submitError.hidden = true;
  slotError.hidden = true;
  setSubmitting(true);
  try {
    const { booking } = await api.createBooking(body, state.idempotencyKey);
    state.idempotencyKey = null;
    setSubmitting(false);
    showSuccess(booking);
    window.sjpTrack?.('booking_submitted');
  } catch (err) {
    setSubmitting(false);
    handleSubmitError(err);
  }
});

// ---------- Confirmation ----------
function googleCalendarUrl(booking) {
  const compact = (iso) => iso.replaceAll('-', '');
  const clock = (hhmm) => `${hhmm.slice(0, 5).replace(':', '')}00`;
  const { startTime, endTime, label } = booking.period;
  const day = compact(booking.date);
  const params = new URLSearchParams({ action: 'TEMPLATE', text: `${booking.service.name} — St Johns Park Valeting` });
  if (startTime) {
    params.set('dates', `${day}T${clock(startTime)}/${day}T${clock(endTime || plusHours(startTime, 3))}`);
  } else {
    params.set('dates', `${day}/${compact(addDays(booking.date, 1))}`);
  }
  params.set('details', [
    `Booking ${booking.reference} (${booking.statusLabel})`,
    startTime ? `${label} slot ${booking.timeLabel}` : `${label} slot — time to be confirmed`,
    `Vehicle: ${booking.vehicle}`,
    booking.handover === 'collection' ? 'We will collect your car.' : `Drop off at ${businessAddress()}`,
    `Track: ${booking.trackUrl}`,
    `Questions? Call ${businessPhone()}`,
  ].join('\n'));
  params.set('location', booking.handover === 'collection' && booking.collectionAddress ? booking.collectionAddress : businessAddress());
  if (startTime) params.set('ctz', state.config.timezone || 'Europe/Dublin');
  return `https://calendar.google.com/calendar/render?${params}`;
}

function plusHours(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + hours * 60, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function showSuccess(booking) {
  state.booking = booking;
  mine.add(`${booking.date}|${booking.period.code}`);
  invalidateWeek(mondayOf(booking.date));
  nextAvail = { from: null, date: undefined, failed: false };

  const deposit = depositEur();
  const contact = booking.email ? `${booking.phone} and ${booking.email}` : booking.phone;
  setText($('[data-done-slot]'), booking.period.label.toLowerCase());
  setText($('[data-done-text]'), `We've reserved ${booking.dateLabel} for your ${booking.service.name}. A confirmation is on its way to ${contact}. `
    + (deposit ? `We'll confirm shortly and then request the ${euro(deposit)} deposit.` : "We'll confirm shortly."));
  setText($('[data-done-ref]'), booking.reference);
  const ics = $('[data-done-ics]');
  ics.hidden = !booking.calendarUrl;
  if (booking.calendarUrl) ics.href = booking.calendarUrl;
  $('[data-done-gcal]').href = googleCalendarUrl(booking);
  $('[data-done-track]').href = `track.html?ref=${encodeURIComponent(booking.reference)}`;
  currentUser().then((user) => {
    $('[data-done-guest]').hidden = Boolean(user);
    $('[data-done-register]').hidden = Boolean(user);
    $('[data-done-member]').hidden = !user;
    $('[data-done-mine]').hidden = !user;
  });

  setSummary('service', booking.service.name, false);
  setSummary('date', booking.dateLabel, false);
  setSummary('slot', `${booking.period.label} · ${booking.timeLabel}`, false);
  setSummary('handover', HANDOVER_LABELS[booking.handover] || HANDOVER_LABELS.drop_off, false);
  $('[data-confirm-wrap]').hidden = true;
  $('[data-reserved]').hidden = false;

  form.hidden = true;
  doneEl.hidden = false;
  doneEl.scrollIntoView({ block: 'start' });
  $('#bk-done-title').focus({ preventScroll: true });
}

/** Start again for another car: keep who they are, clear what they booked. */
function bookAnother() {
  state.booking = null;
  state.service = null;
  state.period = null;
  state.addons.clear();
  state.discount = null;
  state.discountTried = null;
  inputs.vehicle.value = '';
  inputs.notes.value = '';
  inputs.discountCode.value = '';
  setDiscountStatus('');
  extrasEl.querySelectorAll('input').forEach((box) => { box.checked = false; });
  showFieldErrors(form, {});
  if (state.date) state.weekStart = mondayOf(state.date);
  doneEl.hidden = true;
  form.hidden = false;
  $('[data-confirm-wrap]').hidden = false;
  $('[data-reserved]').hidden = true;
  render();
  $('#bk-s1').closest('section').scrollIntoView({ block: 'start' });
  const first = servicesEl.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

// ---------- Events ----------
thisWeekBtn.addEventListener('click', () => goToWeek(mondayOf(state.today)));
prevBtn.addEventListener('click', () => {
  goToWeek(addDays(state.weekStart, -7));
  if (prevBtn.disabled) nextBtn.focus();
});
nextBtn.addEventListener('click', () => {
  goToWeek(addDays(state.weekStart, 7));
  if (nextBtn.disabled) prevBtn.focus();
});
weekError.querySelector('[data-week-retry]').addEventListener('click', () => {
  weekErrors.delete(state.weekStart);
  state.searchError = null;
  if (!state.date && !state.noneFree) pickFirstDate();
  else render();
});
jumpBtn.addEventListener('click', () => {
  if (!nextAvail.date) return;
  state.date = nextAvail.date;
  state.weekStart = mondayOf(nextAvail.date);
  state.period = null;
  render();
  const day = weekEl.querySelector('[aria-pressed="true"]');
  if (day) day.focus();
});
handoverBtns.forEach((btn) => btn.addEventListener('click', () => {
  state.handover = btn.dataset.handover;
  renderHandover();
  renderSummary();
}));
form.addEventListener('input', (event) => {
  if (!event.target.matches('input, textarea')) return;
  clearFieldError(event.target);
  renderSummary();
});
// Editing the code clears the applied discount until "Apply" is pressed again; Enter applies instead of submitting.
inputs.discountCode.addEventListener('input', () => {
  discountSeq += 1;
  discountBtn.disabled = false;
  state.discount = null;
  state.discountTried = null;
  setDiscountStatus('');
  renderSummary();
});
inputs.discountCode.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  applyDiscount();
});
discountBtn.addEventListener('click', applyDiscount);
$('[data-book-another]').addEventListener('click', bookAnother);
$('[data-load-retry]').addEventListener('click', init);

// ---------- Start ----------
currentUser().then((user) => {
  state.user = user;
  if (!user) return;
  const prefill = { name: user.fullName, phone: user.phone, email: user.email };
  for (const [name, value] of Object.entries(prefill)) {
    if (value && !inputs[name].value) inputs[name].value = value;
  }
  renderSummary();
  // The address saved on My profile becomes the collection address, if they ask us to collect the car.
  api.profile().then(({ profile }) => {
    const a = profile.address;
    const address = [a.line1, a.line2, a.town, a.county ? `Co. ${a.county.replace(/^Co\.?\s*/i, '')}` : null, a.eircode].filter(Boolean).join(', ');
    if (address && !inputs.collectionAddress.value) inputs.collectionAddress.value = address.slice(0, 300);
  }).catch(() => {});
});

async function init() {
  loadError.hidden = true;
  try {
    state.config = await api.config();
  } catch (err) {
    setText(loadError.querySelector('[data-load-error-text]'), `We couldn't load the booking calendar. ${errorMessage(err)}`);
    loadError.hidden = false;
    form.hidden = true;
    return;
  }
  if (state.config.booking && state.config.booking.paused) {
    showPaused(state.config.booking.pausedMessage);
    return;
  }
  form.hidden = false;
  buildServices();
  buildSizes();
  buildExtras();
  const wanted = param('service');
  if ((state.config.services || []).some((s) => s.code === wanted)) state.service = wanted;
  const deposit = depositEur();
  $('[data-deposit-wrap]').hidden = !deposit;
  if (deposit) setText($('[data-deposit]'), euro(deposit));
  state.weekStart = mondayOf(state.today);
  pickFirstDate();
}

init();
