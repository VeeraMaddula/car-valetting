// Admin dashboard: overview, bookings, services & prices, discounts, photos, customers, analytics and settings.
// One page; the hash picks the screen (#bookings?date=2026-10-21). "Bookings only" team members see the
// bookings screen only. Every value from the API is rendered with el(), which sets text, never HTML.
import { api, ApiError, newIdempotencyKey, request } from './api.js';
import { addDays, clearFieldError, currentUser, el, fmt, icon, ICONS, isoDate, mondayOf, parseDate, showFieldErrors, toast } from './ui.js';

const SIGN_IN = 'account.html?next=admin.html';
const GENERIC = 'Something went wrong. Please try again.';

// ---------- API ----------

const enc = encodeURIComponent;
const A = {
  badges: () => request('GET', '/admin/badges'),
  overview: (range) => request('GET', `/admin/overview?range=${range}`),
  bookings: (from, to) => request('GET', `/admin/bookings?from=${from}&to=${to}`),
  booking: (ref) => request('GET', `/admin/bookings/${enc(ref)}`),
  updateBooking: (ref, body) => request('PATCH', `/admin/bookings/${enc(ref)}`, { body }),
  createBooking: (body, key) => request('POST', '/admin/bookings', { body, headers: { 'Idempotency-Key': key }, timeout: 20000 }),
  blocks: (from, to) => request('GET', `/admin/blocks?from=${from}&to=${to}`),
  addBlock: (body) => request('POST', '/admin/blocks', { body }),
  removeBlock: (id) => request('DELETE', `/admin/blocks/${enc(id)}`),
  periods: () => request('GET', '/admin/slot-periods'),
  savePeriod: (code, body) => request('PUT', `/admin/slot-periods/${enc(code)}`, { body }),
  jobs: () => request('GET', '/admin/jobs?status=failed'),
  retryJob: (id) => request('POST', `/admin/jobs/${enc(id)}/retry`, { body: {} }),
  health: () => request('GET', '/admin/notifications/health'),
  analytics: (range, refresh) => request('GET', `/admin/analytics?range=${range}${refresh ? '&refresh=1' : ''}`, { timeout: 25000 }),
  live: () => request('GET', '/admin/analytics/live'),
  pricing: () => request('GET', '/admin/pricing'),
  savePricing: (body) => request('PUT', '/admin/pricing', { body }),
  sales: () => request('GET', '/admin/sales'),
  saveSales: (body) => request('PUT', '/admin/sales', { body }),
  discounts: () => request('GET', '/admin/discounts'),
  createDiscount: (body) => request('POST', '/admin/discounts', { body }),
  updateDiscount: (id, body) => request('PUT', `/admin/discounts/${enc(id)}`, { body }),
  pauseDiscount: (id, paused) => request('POST', `/admin/discounts/${enc(id)}/${paused ? 'pause' : 'resume'}`, { body: {} }),
  customers: (q) => request('GET', `/admin/customers?${q}`),
  customersCsv: (q) => request('GET', `/admin/customers.csv?${q}`, { blob: true, timeout: 30000 }),
  customer: (key) => request('GET', `/admin/customers/${enc(key)}`),
  saveNote: (key, note) => request('PUT', `/admin/customers/${enc(key)}/note`, { body: { note } }),
  resetLink: (key) => request('POST', `/admin/customers/${enc(key)}/password-reset`, { body: {} }),
  eraseCustomer: (key) => request('DELETE', `/admin/customers/${enc(key)}`),
  upload: (file) => request('POST', '/admin/images', { body: file, raw: true, headers: { 'Content-Type': imageType(file) }, timeout: 90000 }),
  slides: () => request('GET', '/admin/slides'),
  addSlide: (body) => request('POST', '/admin/slides', { body }),
  publishSlides: (body) => request('PUT', '/admin/slides', { body }),
  removeSlide: (id) => request('DELETE', `/admin/slides/${enc(id)}`),
  photos: () => request('GET', '/admin/photos'),
  addPhotos: (items) => request('POST', '/admin/photos', { body: { items } }),
  updatePhoto: (id, body) => request('PATCH', `/admin/photos/${enc(id)}`, { body }),
  removePhoto: (id) => request('DELETE', `/admin/photos/${enc(id)}`),
  pairs: () => request('GET', '/admin/before-after'),
  addPair: (body) => request('POST', '/admin/before-after', { body }),
  updatePair: (id, body) => request('PATCH', `/admin/before-after/${enc(id)}`, { body }),
  removePair: (id) => request('DELETE', `/admin/before-after/${enc(id)}`),
  settings: () => request('GET', '/admin/settings'),
  saveSettings: (body) => request('PUT', '/admin/settings', { body }),
  integrations: () => request('GET', '/admin/integrations'),
  testEmail: () => request('POST', '/admin/integrations/email/test', { body: {}, timeout: 20000 }),
  testSms: () => request('POST', '/admin/integrations/sms/test', { body: {}, timeout: 20000 }),
  syncCalendar: () => request('POST', '/admin/integrations/calendar/sync', { body: {} }),
  team: () => request('GET', '/admin/team'),
  invite: (body) => request('POST', '/admin/team/invites', { body }),
  revokeInvite: (id) => request('DELETE', `/admin/team/invites/${enc(id)}`),
  removeMember: (id) => request('DELETE', `/admin/team/members/${enc(id)}`),
  /** Fresh, not the cached copy the public pages use (the query string skips the 60-second HTTP cache too). */
  config: () => request('GET', `/config?t=${Date.now()}`),
};

/** Windows often gives HEIC photos no type; the server only accepts image types, so fall back to the extension. */
const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
function imageType(file) {
  return file.type || EXT_TYPES[(file.name.split('.').pop() || '').toLowerCase()] || 'image/jpeg';
}

// ---------- Small helpers ----------

const $ = (selector, root = document) => root.querySelector(selector);
const todayIso = () => isoDate(new Date());
const STATUS = { pending: 'Awaiting confirmation', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'Missed' };
/** Short labels for the narrow week-grid cells (the full status is in the detail panel and the cell's label). */
const CELL_TAGS = { pending: 'To confirm', confirmed: 'Confirmed', completed: 'Done', no_show: 'Missed' };
const DEPOSIT = { not_requested: 'Not requested', requested: 'Requested', paid: 'Paid', refunded: 'Refunded', waived: 'Waived' };
const ACTIVE = new Set(['pending', 'confirmed']);
const PERIOD_ORDER = { morning: 0, afternoon: 1, evening: 2 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** '€90', '€76.50', '€1,240' (null → '—'). */
function euro(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return `€${n.toLocaleString('en-IE', Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** 'K7Q49XZ2' → 'SJP-K7Q4-9XZ2'; already formatted references pass through. */
function fmtRef(ref) {
  const s = String(ref || '');
  return /^[0-9A-Z]{8}$/.test(s) ? `SJP-${s.slice(0, 4)}-${s.slice(4)}` : s;
}
const sameRef = (a, b) => fmtRef(a).replace(/-/g, '') === fmtRef(b).replace(/-/g, '');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const num = (value) => (value === '' || value === null || value === undefined ? null : Number(value));

function relDay(iso) {
  if (!iso) return '—';
  const diff = Math.round((parseDate(todayIso()) - parseDate(iso)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return `${fmt.short(iso)}${iso.slice(0, 4) !== todayIso().slice(0, 4) ? ` ${iso.slice(0, 4)}` : ''}`;
}
function relTime(at) {
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return fmt.dateTime(at);
}
function seconds(total) {
  const s = Math.round(total || 0);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
function daysLabel(days) {
  const set = [...new Set(days)].sort();
  if (set.join() === '1,2,3,4,5,6') return 'Monday to Saturday';
  if (set.join() === '1,2,3,4,5') return 'Monday to Friday';
  if (set.join() === '0,1,2,3,4,5,6') return 'Every day';
  return set.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ') || 'No days';
}

function pill(status, label) {
  return el('span', { class: `pill pill-${status}`, text: label || STATUS[status] || status });
}

function handleError(err) {
  if (err && err.code === 'UNAUTHENTICATED') {
    location.replace(SIGN_IN);
    return;
  }
  toast(err instanceof ApiError ? err.message : GENERIC, { error: true });
}

/** Run an action with a busy button (one click at a time). onError returns true if it dealt with the error. */
async function busy(button, action, onError) {
  if (button && button.getAttribute('aria-busy') === 'true') return undefined;
  if (button) {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  }
  try {
    return await action();
  } catch (err) {
    if (!(onError && onError(err))) handleError(err);
    return undefined;
  } finally {
    if (button) {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      const s = button.querySelector('.spinner');
      if (s) s.remove();
    }
  }
}

function btn(label, onclick, { kind = 'ghost', size = 'sm', type = 'button', attrs = {} } = {}) {
  return el('button', { class: `btn btn-${kind}${size ? ` btn-${size}` : ''}`, type, onclick, ...attrs }, label);
}

let uid = 0;
/** A labelled field (site .field styling) with an error slot that showFieldErrors() fills by input name. */
function field(label, control, { hint, cls = '' } = {}) {
  const id = control.id || `f${++uid}`;
  control.id = id;
  control.setAttribute('aria-describedby', `${id}-error`);
  return el('div', { class: `field ${cls}`.trim() },
    el('label', { for: id, text: label }),
    control,
    hint ? el('span', { class: 'hint', text: hint }) : null,
    el('span', { class: 'error', id: `${id}-error` }));
}
function inputEl(attrs = {}, value) {
  const node = el('input', { type: 'text', ...attrs });
  if (value !== undefined && value !== null) node.value = String(value);
  return node;
}
function textareaEl(attrs = {}, value) {
  const node = el('textarea', { rows: '3', ...attrs });
  node.value = value || '';
  return node;
}
function selectEl(attrs, options, value) {
  const node = el('select', attrs, options.map(([v, label]) => el('option', { value: v, text: label })));
  if (value !== undefined && value !== null) node.value = String(value);
  return node;
}
function switchEl(label, checked, onChange, attrs = {}) {
  const box = el('input', { type: 'checkbox', role: 'switch', ...attrs });
  box.checked = Boolean(checked);
  box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'adm-switch' }, box, el('span', { class: 'adm-switch-track', 'aria-hidden': 'true' }), el('span', { text: label }));
}
function checkEl(label, checked, onChange, attrs = {}) {
  const box = el('input', { type: 'checkbox', ...attrs });
  box.checked = Boolean(checked);
  if (onChange) box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'adm-check' }, box, el('span', { text: label }));
}
function seg(options, value, onPick, label) {
  return el('div', { class: 'adm-seg', role: 'group', 'aria-label': label },
    options.map(([v, text]) => el('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onPick(v) }, text)));
}
function head(id, title, sub, actions = []) {
  return el('div', { class: 'adm-head' },
    el('div', { class: 'adm-head-copy' },
      el('h1', { class: 'adm-title', id, tabindex: '-1', text: title }),
      sub ? el('p', { class: 'adm-sub', text: sub }) : null),
    actions.length ? el('div', { class: 'adm-actions' }, actions) : null);
}
function card(title, children, { actions = [], cls = '' } = {}) {
  return el('section', { class: `adm-card ${cls}`.trim() },
    title || actions.length ? el('div', { class: 'adm-card-head' }, title ? el('h2', { class: 'adm-card-title', text: title }) : el('span'), actions.length ? el('div', { class: 'adm-actions' }, actions) : null) : null,
    children);
}
const loadingBlock = (text = 'Loading…') => el('div', { class: 'adm-loading', role: 'status' }, el('span', { class: 'spinner spinner-light', 'aria-hidden': 'true' }), text);
function errorBlock(err, retry) {
  return el('div', { class: 'notice notice-error adm-error', role: 'alert' },
    el('p', { text: err instanceof ApiError ? err.message : GENERIC }),
    retry ? btn('Try again', retry, { kind: 'text' }) : null);
}
const empty = (text) => el('p', { class: 'adm-empty', text });

function setFormError(form, message) {
  const node = $('[data-form-error]', form);
  if (node) node.textContent = message || '';
}
/** Show an ApiError on a form: field messages next to inputs, anything else in the form's notice. */
function showApiError(form, err) {
  if (err && err.code === 'UNAUTHENTICATED') { handleError(err); return true; }
  const fields = (err && err.fields) || {};
  const placed = {};
  const rest = [];
  for (const [name, message] of Object.entries(fields)) {
    if (form.querySelector(`[name="${CSS.escape(name)}"]`)) placed[name] = message;
    else rest.push(message);
  }
  const shown = showFieldErrors(form, placed);
  setFormError(form, rest.length ? rest.join(' ') : shown ? '' : (err instanceof ApiError ? err.message : GENERIC));
  return true;
}
const formNotice = () => el('p', { class: 'notice notice-error adm-form-error', role: 'alert', 'data-form-error': '' });

/** Remembers the saved state of a form so the save bar knows whether anything changed. */
function draft(initial) {
  let saved = JSON.stringify(initial);
  return {
    value: JSON.parse(saved),
    get dirty() { return JSON.stringify(this.value) !== saved; },
    reset(next) { saved = JSON.stringify(next); this.value = JSON.parse(saved); },
    discard() { this.value = JSON.parse(saved); },
  };
}
function saveBar(d, { onSave, onDiscard, label = 'You have unsaved changes' }) {
  const save = btn('Save changes', null, { kind: 'gold' });
  const bar = el('div', { class: 'adm-savebar', role: 'region', 'aria-label': 'Unsaved changes' },
    el('p', { text: label }),
    el('div', { class: 'adm-actions' }, btn('Discard', onDiscard), save));
  save.addEventListener('click', () => onSave(save));
  const refresh = () => { bar.hidden = !d.dirty; };
  refresh();
  return { el: bar, refresh };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Copy failed: select the link and copy it.', { error: true });
  }
}

// ---------- Dialogs ----------

const confirmBox = $('[data-confirm]');
/** Resolves true when confirmed. `extra` is an optional node (e.g. a reason box) shown in the dialog. */
function confirmDialog({ title, text, confirmLabel = 'Confirm', cancelLabel = 'Keep', danger = false, extra = null }) {
  $('[data-confirm-title]', confirmBox).textContent = title;
  $('[data-confirm-text]', confirmBox).textContent = text || '';
  $('[data-confirm-extra]', confirmBox).replaceChildren(...(extra ? [extra] : []));
  const ok = $('[data-confirm-ok]', confirmBox);
  ok.textContent = confirmLabel;
  ok.className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-gold'}`;
  $('[data-confirm-cancel]', confirmBox).textContent = cancelLabel;
  confirmBox.returnValue = '';
  confirmBox.showModal();
  return new Promise((resolve) => confirmBox.addEventListener('close', () => resolve(confirmBox.returnValue === 'ok'), { once: true }));
}

const modalBox = $('[data-modal]');
const modal = {
  open(title, content) {
    $('[data-modal-title]', modalBox).textContent = title;
    $('[data-modal-content]', modalBox).replaceChildren(content);
    document.documentElement.classList.add('adm-modal-open');
    modalBox.showModal();
    const first = content.querySelector('input:not([type="hidden"]), select, textarea');
    if (first) first.focus();
  },
  close() { modalBox.close(); },
};
$('[data-modal-close]', modalBox).addEventListener('click', () => modal.close());
modalBox.addEventListener('close', () => {
  document.documentElement.classList.remove('adm-modal-open');
  $('[data-modal-content]', modalBox).replaceChildren();
});

// ---------- Charts (single series, gold; hover/focus tooltip; table view) ----------

/** points: [{ label, tip, value }]; axis shows the first, middle and last labels. */
function barChart(points, { caption, valueLabel }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const bars = el('div', { class: 'adm-bars' }, points.map((p) =>
    el('span', { class: `adm-bar${p.value ? '' : ' adm-bar-zero'}`, tabindex: '0', role: 'img', 'aria-label': p.tip },
      el('span', { class: 'adm-bar-fill', style: { height: `${Math.max(1, (p.value / max) * 100)}%` } }),
      el('span', { class: 'adm-bar-tip', 'aria-hidden': 'true', text: p.tip }))));
  const pick = points.length > 2 ? [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]] : points;
  const axis = el('div', { class: 'adm-axis', 'aria-hidden': 'true' }, pick.map((p) => el('span', { text: p.label })));
  const table = el('div', { class: 'adm-table-wrap', hidden: true },
    el('table', { class: 'adm-table' },
      el('caption', { class: 'sr-only', text: caption }),
      el('thead', {}, el('tr', {}, el('th', { text: 'Date' }), el('th', { class: 'num', text: valueLabel }))),
      el('tbody', {}, points.map((p) => el('tr', {}, el('td', { text: p.label }), el('td', { class: 'num', text: String(p.value) }))))));
  const chart = el('div', { class: 'adm-chart' }, bars, axis);
  const toggle = el('button', { class: 'adm-table-toggle', type: 'button', 'aria-pressed': 'false' }, 'Show table');
  toggle.addEventListener('click', () => {
    const showTable = table.hidden;
    table.hidden = !showTable;
    chart.hidden = showTable;
    toggle.textContent = showTable ? 'Show chart' : 'Show table';
    toggle.setAttribute('aria-pressed', String(showTable));
  });
  return el('div', { class: 'adm-chart' }, chart, table, el('div', { class: 'adm-chart-foot' }, el('span', { class: 'adm-note', text: caption }), toggle));
}
/** rows: [{ name, value, share, display? }] as horizontal bars with direct labels. */
function shareBars(rows) {
  if (!rows.length) return empty('No data yet.');
  return el('ul', { class: 'adm-share' }, rows.map((r) => el('li', {},
    el('span', { class: 'adm-share-name', text: r.name, title: r.name }),
    el('span', { class: 'adm-share-track', 'aria-hidden': 'true' }, el('span', { class: 'adm-share-fill', style: { width: `${Math.min(100, Math.max(0, r.share))}%` } })),
    el('span', { class: 'adm-share-value', text: r.display || `${r.share}%` }))));
}
function tile(label, value, { change, sub } = {}) {
  return el('div', { class: 'adm-tile' },
    el('span', { class: 'adm-tile-label', text: label }),
    el('span', { class: 'adm-tile-value', text: value }),
    change || null,
    sub ? el('span', { class: 'adm-tile-sub', text: sub }) : null);
}
function change(current, previous, days, { points = false } = {}) {
  const span = (cls, text) => el('span', { class: `adm-change ${cls}`.trim(), text });
  if (points) {
    const d = Math.round((current - previous) * 10) / 10;
    return span(d > 0 ? 'is-up' : d < 0 ? 'is-down' : '', `${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d)} pts vs previous ${days} days`);
  }
  if (!previous) return span(current ? 'is-up' : '', current ? `▲ New vs previous ${days} days` : `• Same as previous ${days} days`);
  const pct = Math.round(((current - previous) / previous) * 100);
  return span(pct > 0 ? 'is-up' : pct < 0 ? 'is-down' : '', `${pct > 0 ? '▲' : pct < 0 ? '▼' : '•'} ${Math.abs(pct)}% vs previous ${days} days`);
}

// ---------- Shared: new booking form (bookings, overview, customers) ----------

async function openBookingForm(prefill = {}, onDone) {
  let config;
  try {
    config = await A.config();
  } catch (err) {
    handleError(err);
    return;
  }
  const key = newIdempotencyKey();
  const services = config.services || [];
  const bySize = config.booking && config.booking.pricesBySize;
  const form = el('form', { class: 'adm-form', novalidate: true });
  const address = field('Collection address', inputEl({ name: 'collectionAddress', maxlength: '300', autocomplete: 'off' }, prefill.collectionAddress));
  address.hidden = true;
  const handover = selectEl({ name: 'handover' }, [['drop_off', 'Drop off at St Johns Park'], ['collection', 'We collect the car']], 'drop_off');
  handover.addEventListener('change', () => { address.hidden = handover.value !== 'collection'; });
  const addons = (config.addons || []).map((a) => checkEl(`${a.name} (+${euro(a.priceEur)})`, false, null, { name: 'addons', value: a.id }));
  const confirmBox2 = checkEl('Confirm straight away (sends the customer their confirmation)', true, null, { name: 'confirm' });

  form.append(
    prefill.customerName ? el('p', { class: 'notice notice-gold', text: `Linked to ${prefill.customerName}'s account.` }) : null,
    el('div', { class: 'adm-fields' },
      field('Service', selectEl({ name: 'serviceCode' }, services.map((s) => [s.code, `${s.name}${s.priceEur !== null ? ` · ${s.priceFrom ? 'from ' : ''}${euro(s.salePriceEur ?? s.priceEur)}` : ''}`]), prefill.serviceCode || (services[0] && services[0].code))),
      bySize ? field('Vehicle size', selectEl({ name: 'vehicleSize' }, [['', 'Not sure (base price)'], ...config.booking.vehicleSizes.map((v) => [v.code, v.label])], '')) : null,
      field('Date', inputEl({ name: 'date', type: 'date', required: true }, prefill.date || todayIso())),
      field('Slot', selectEl({ name: 'period' }, (config.periods || []).map((p) => [p.code, p.label]), prefill.period || 'morning'))),
    addons.length ? el('fieldset', { class: 'adm-checks', style: { border: '0', padding: '0', margin: '0' } }, el('legend', { class: 'label', text: 'Extras' }), addons) : null,
    el('div', { class: 'adm-fields' },
      field('Customer name', inputEl({ name: 'name', maxlength: '100', autocomplete: 'off' }, prefill.name)),
      field('Phone', inputEl({ name: 'phone', type: 'tel', maxlength: '30', autocomplete: 'off' }, prefill.phone)),
      field('Email (optional)', inputEl({ name: 'email', type: 'email', maxlength: '254', autocomplete: 'off' }, prefill.email)),
      field('Vehicle', inputEl({ name: 'vehicle', maxlength: '120', autocomplete: 'off', placeholder: 'Make, model & colour' }, prefill.vehicle))),
    el('div', { class: 'adm-fields' },
      field('Handover', handover),
      field('Discount code (optional)', inputEl({ name: 'discountCode', maxlength: '30', autocomplete: 'off', autocapitalize: 'characters' }))),
    address,
    field('Notes (optional)', textareaEl({ name: 'notes', maxlength: '1000' })),
    confirmBox2,
    formNotice(),
    el('div', { class: 'adm-dialog-actions' }, btn('Cancel', () => modal.close()), btn('Create booking', null, { kind: 'gold', type: 'submit' })));
  form.addEventListener('input', (e) => { if (e.target.matches('input, select, textarea')) clearFieldError(e.target); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = form.elements;
    const value = (name) => (f[name] ? f[name].value.trim() : '');
    const body = {
      serviceCode: value('serviceCode'),
      date: value('date'),
      period: value('period'),
      name: value('name'),
      phone: value('phone'),
      email: value('email') || null,
      vehicle: value('vehicle'),
      handover: value('handover'),
      collectionAddress: value('handover') === 'collection' ? value('collectionAddress') || null : null,
      notes: value('notes') || null,
      discountCode: value('discountCode') || null,
      vehicleSize: value('vehicleSize') || null,
      addons: [...form.querySelectorAll('input[name="addons"]:checked')].map((c) => c.value),
      confirm: form.querySelector('input[name="confirm"]').checked,
      customerUserId: prefill.customerUserId || null,
    };
    setFormError(form, '');
    busy(form.querySelector('[type="submit"]'), async () => {
      const { booking } = await A.createBooking(body, key);
      modal.close();
      toast(`Booked ${booking.reference} for ${fmt.short(booking.date)}, ${booking.period.label.toLowerCase()}.`);
      refreshBadges();
      if (onDone) onDone(booking);
    }, (err) => showApiError(form, err));
  });
  modal.open('New booking', form);
}

// ---------- Badges ----------

const badgeEl = $('[data-badge]');
async function refreshBadges() {
  try {
    const b = await A.badges();
    badgeEl.hidden = !b.pendingBookings;
    badgeEl.textContent = String(b.pendingBookings);
    badgeEl.setAttribute('aria-label', `${b.pendingBookings} awaiting confirmation`);
  } catch {
    // Badges are a nicety; the screens show the same figures.
  }
}

// =====================================================================================
// Overview
// =====================================================================================

const overview = {
  range: 30,
  async open(root, params) {
    this.range = [7, 30, 90].includes(Number(params.get('range'))) ? Number(params.get('range')) : this.range;
    root.replaceChildren(loadingBlock('Loading your overview…'));
    let o;
    try {
      o = await A.overview(this.range);
    } catch (err) {
      root.replaceChildren(errorBlock(err, () => this.open(root, params)));
      return;
    }
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const first = (me.fullName || '').split(/\s+/)[0] || me.username;
    const days = o.rangeDays;
    const t = o.tiles;
    const tiles = el('div', { class: 'adm-tiles' },
      tile('Bookings', String(t.bookings.value), { change: change(t.bookings.value, t.bookings.previous, days), sub: 'Booked in this period' }),
      tile('Revenue', euro(t.revenue.value), { change: change(t.revenue.value, t.revenue.previous, days), sub: 'Completed valets' }),
      tile('New customers', String(t.newCustomers.value), { change: change(t.newCustomers.value, t.newCustomers.previous, days) }),
      t.visitors
        ? tile('Website visitors', t.visitors.value.toLocaleString('en-IE'), { change: change(t.visitors.value, t.visitors.previous, days) })
        : tile('Website visitors', '—', { sub: 'Connect Google Analytics in Settings' }),
      t.conversion
        ? tile('Visitors who booked', `${t.conversion.value}%`, { change: change(t.conversion.value, t.conversion.previous, days, { points: true }) })
        : tile('Visitors who booked', '—', { sub: 'Needs Google Analytics' }));

    const weekly = o.bookingsSeries.granularity === 'week';
    const bookingsChart = card(weekly ? 'Bookings per week' : 'Bookings per day', barChart(o.bookingsSeries.points.map((p) => ({
      label: fmt.short(p.date),
      value: p.count,
      tip: `${weekly ? 'Week of ' : ''}${fmt.short(p.date)}: ${plural(p.count, 'booking')}`,
    })), { caption: `Confirmed and completed bookings · max 3 slots a day / 18 a week`, valueLabel: 'Bookings' }));
    const visitorsChart = o.visitorsSeries
      ? card('Website visitors per day', barChart(o.visitorsSeries.map((p) => ({ label: fmt.short(p.date), value: p.visitors, tip: `${fmt.short(p.date)}: ${plural(p.visitors, 'visitor')}` })), { caption: 'From Google Analytics', valueLabel: 'Visitors' }))
      : card('Website visitors per day', el('p', { class: 'adm-note', text: 'Connect Google Analytics (Settings › Connected services) to see visitors here.' }));

    const slotRows = o.closedToday
      ? [el('li', {}, el('span', { class: 'adm-list-sub', text: `Closed on ${DAY_NAMES[parseDate(o.today).getDay()]}s.` }))]
      : o.todaySlots.map((s) => el('li', {},
        el('div', { class: 'adm-list-main' },
          el('span', { class: 'adm-list-title', text: s.booking ? s.booking.name : s.status === 'free' ? 'Free' : 'Closed' }),
          el('span', { class: 'adm-list-sub', text: `${s.label}${s.time ? ` · ${s.time}` : ' · time TBC'}${s.booking ? ` · ${s.booking.service}${s.booking.vehicle ? ` · ${s.booking.vehicle}` : ''}` : ''}` })),
        s.booking ? el('a', { href: `#bookings?date=${o.today}&ref=${enc(s.booking.reference)}` }, pill(s.status)) : el('span', { class: 'pill', text: s.status === 'free' ? 'Free' : 'Closed' })));
    const nextMonday = addDays(mondayOf(o.today), 7);
    const attention = [
      [o.attention.awaitingConfirmation, 'Bookings awaiting your confirmation', '#bookings'],
      [o.attention.depositsUnpaid, 'Deposits requested but not paid', '#bookings'],
      [o.attention.failedMessages, 'Messages that failed to send', '#bookings'],
      [o.attention.slotsLeftNextWeek, 'Slots left next week', `#bookings?date=${nextMonday}`],
    ].map(([n, label, href]) => el('li', {},
      el('a', { href, class: 'adm-row', style: { flex: '1', color: 'inherit' } }, el('span', { class: 'adm-attn-count', text: String(n) }), el('span', { class: 'adm-list-title', text: label }))));

    root.replaceChildren(
      head('h-overview', `${greet}, ${first}`, fmt.long(o.today), [
        seg([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']], this.range, (r) => { location.hash = `overview?range=${r}`; }, 'Date range'),
        el('a', { class: 'btn btn-ghost btn-sm', href: '#bookings' }, 'Open bookings'),
        btn('New booking', () => openBookingForm({}, (b) => { location.hash = `bookings?date=${b.date}&ref=${enc(b.reference)}`; }), { kind: 'gold' }),
      ]),
      tiles,
      el('div', { class: 'adm-cols' }, bookingsChart, visitorsChart),
      el('div', { class: 'adm-cols' },
        card("Today's slots", el('ul', { class: 'adm-list' }, slotRows), { actions: [el('a', { class: 'link-arrow', href: `#bookings?date=${o.today}` }, 'All bookings')] }),
        card('Needs your attention', el('ul', { class: 'adm-list' }, attention))),
      el('div', { class: 'adm-cols' },
        card('Bookings by service', shareBars(o.serviceMix.map((s) => ({ name: s.name, share: s.share, display: `${s.count} · ${s.share}%` })))),
        card('Recent activity', o.activity.length
          ? el('ul', { class: 'adm-list adm-activity' }, o.activity.map((a) => el('li', {},
            el('span', { class: 'adm-list-title', text: a.text }),
            el('time', { datetime: a.at, text: relTime(a.at) }))))
          : empty('Nothing yet. New bookings, cancellations and payments will show here.'))));
  },
};

// =====================================================================================
// Bookings
// =====================================================================================

const EVENT_LABELS = {
  created: 'Booked', confirmed: 'Confirmed', cancelled: 'Cancelled', completed: 'Completed', no_show: 'Marked as missed',
  deposit_requested: 'Deposit requested', deposit_paid: 'Deposit received', deposit_refunded: 'Deposit refunded', deposit_waived: 'Deposit waived',
  deposit_link_sent: 'Payment link sent', deposit_failed: 'Payment did not go through', claimed: 'Added to their account', note: 'Note', price_set: 'Charged amount',
};
const JOB_LABELS = {
  customer_email: 'Email to customer', customer_sms: 'Text to customer', owner_email: 'Email to you', owner_sms: 'Text to you',
  'gcal.sync': 'Google Calendar update', 'auth.password_reset': 'Password reset email', 'owner.daily_summary': 'Daily summary email',
  'team.invite': 'Team invite email', 'deposit.link': 'Deposit payment link', 'deposit.refund': 'Deposit refund', 'deposit.expire': 'Expire payment link',
};
const actorLabel = (actor) => (actor === 'customer' || actor === 'guest' ? 'by the customer' : actor.startsWith('admin:') ? 'by the team' : actor === 'stripe' ? 'via Stripe' : '');

const bookings = {
  week: null,
  data: null,
  selected: null, // { date, period }
  details: new Map(), // reference → { booking, events } | 'loading' | Error
  root: null,

  async open(root, params) {
    this.root = root;
    const date = params.get('date');
    this.week = mondayOf(date || this.week || todayIso());
    this.wantRef = params.get('ref');
    if (date && params.get('period')) this.selected = { date, period: params.get('period') };
    await this.load();
  },

  async load() {
    const root = this.root;
    if (!this.data) root.replaceChildren(loadingBlock('Loading bookings…'));
    const from = this.week;
    const to = addDays(from, 6);
    try {
      const [b, blocks, periods, badges, health, jobs, integ] = await Promise.all([
        A.bookings(from, to), A.blocks(from, to), A.periods(), A.badges(), A.health(), A.jobs(),
        isAdmin ? A.integrations().catch(() => null) : Promise.resolve(null),
      ]);
      this.data = { from, bookings: b.bookings, blocks: blocks.blocks, periods: periods.periods, badges, health, jobs: jobs.jobs, integ };
    } catch (err) {
      root.replaceChildren(errorBlock(err, () => this.load()));
      return;
    }
    if (this.wantRef) {
      const found = this.data.bookings.find((x) => sameRef(x.reference, this.wantRef) && x.status !== 'cancelled')
        || this.data.bookings.find((x) => sameRef(x.reference, this.wantRef));
      if (found) this.selected = { date: found.date, period: found.period.code, ref: found.reference };
      this.wantRef = null;
    }
    this.details.clear();
    this.render();
  },

  activePeriods() {
    return this.data.periods.filter((p) => p.active).sort((a, b) => a.sort - b.sort || PERIOD_ORDER[a.code] - PERIOD_ORDER[b.code]);
  },
  days() {
    const sunday = this.activePeriods().some((p) => p.daysOfWeek.includes(0));
    return Array.from({ length: sunday ? 7 : 6 }, (_, i) => addDays(this.week, i));
  },
  cell(date, period) {
    const booking = this.data.bookings.find((b) => b.date === date && b.period.code === period.code && b.status !== 'cancelled');
    if (booking) return { kind: 'booking', booking };
    if (date < todayIso()) return { kind: 'past' };
    const block = this.data.blocks.find((x) => x.date === date && (x.period === period.code || x.period === 'all'));
    if (block) return { kind: 'closed', block };
    if (!period.daysOfWeek.includes(parseDate(date).getDay())) return { kind: 'off' };
    return { kind: 'free' };
  },

  render() {
    const d = this.data;
    const today = todayIso();
    const days = this.days();
    const periods = this.activePeriods();
    const inWeek = today >= this.week && today <= addDays(this.week, 6);
    let booked = 0;
    let open = 0;
    let todayBooked = 0;
    let todaySlots = 0;
    for (const date of days) {
      for (const p of periods) {
        const c = this.cell(date, p);
        if (c.kind !== 'off') open += 1;
        if (c.kind === 'booking') booked += 1;
        if (date === today && c.kind !== 'off') { todaySlots += 1; if (c.kind === 'booking') todayBooked += 1; }
      }
    }
    const deposits = d.bookings.filter((b) => ACTIVE.has(b.status) && b.deposit.status === 'requested');
    const depositAmount = deposits[0] ? deposits[0].deposit.amountEur : null;
    const weekLabel = `${inWeek ? 'This week · ' : ''}${fmt.short(days[0])} – ${fmt.short(days[days.length - 1])}`;

    const grid = el('div', { class: 'adm-week', style: { gridTemplateColumns: `minmax(72px, 100px) repeat(${days.length}, minmax(84px, 1fr))` } });
    grid.append(el('span'));
    for (const date of days) {
      grid.append(el('div', { class: `adm-week-head adm-week-day${date === today ? ' is-today' : ''}` },
        el('span', { text: date === today ? 'Today' : fmt.dow(date) }), el('strong', { text: String(parseDate(date).getDate()) })));
    }
    for (const p of periods) {
      const time = p.startTime ? `${p.startTime.slice(0, 5)}–${(p.endTime || '').slice(0, 5)}` : 'Time TBC';
      grid.append(el('div', { class: 'adm-week-period' }, el('span', { text: p.label }), el('span', { text: time })));
      for (const date of days) grid.append(this.cellButton(date, p));
    }

    const aside = el('aside', { 'aria-label': 'Selected slot' }, this.detailPanel());
    this.root.replaceChildren(
      head('h-bookings', 'Bookings', 'Tap a slot to see the booking, confirm it or close the slot.', [
        btn('New booking', () => openBookingForm({}, (b) => this.goTo(b)), { kind: 'gold' }),
      ]),
      el('div', { class: 'adm-tiles' },
        inWeek ? tile('Today', `${todayBooked} of ${todaySlots}`, { sub: 'slots booked' }) : tile('This week', String(booked), { sub: plural(booked, 'booking') }),
        tile('Awaiting confirmation', String(d.badges.pendingBookings), { sub: 'All upcoming bookings' }),
        tile('Deposits outstanding', String(deposits.length), { sub: deposits.length && depositAmount ? `× ${euro(depositAmount)}` : 'This week' }),
        tile('Week filled', open ? `${Math.round((booked / open) * 100)}%` : '—', { sub: `${booked} of ${open} slots` })),
      el('div', { class: 'adm-split' },
        el('div', { class: 'adm-stack', style: { gap: '20px' } },
          el('div', { class: 'adm-card' },
            el('div', { class: 'adm-week-bar' },
              el('p', { class: 'adm-week-label', 'aria-live': 'polite', text: weekLabel }),
              el('div', { class: 'adm-actions' },
                btn('This week', () => this.goWeek(mondayOf(today))),
                el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous week', onclick: () => this.goWeek(addDays(this.week, -7)) }, icon(ICONS.chevronLeft)),
                el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next week', onclick: () => this.goWeek(addDays(this.week, 7)) }, icon(ICONS.chevronRight)))),
            el('div', { class: 'adm-table-wrap' }, grid)),
          this.slotTimesCard(),
          this.notificationsCard()),
        aside));
  },

  cellButton(date, period) {
    const c = this.cell(date, period);
    const sel = this.selected && this.selected.date === date && this.selected.period === period.code;
    let cls = `adm-cell is-${c.kind}`;
    let name;
    let meta;
    let tag;
    let spoken;
    if (c.kind === 'booking') {
      const b = c.booking;
      cls = `adm-cell is-${b.status}`;
      name = b.customerName;
      meta = `${b.service.name}${b.vehicle ? ` · ${b.vehicle}` : ''}`;
      tag = CELL_TAGS[b.status] || STATUS[b.status];
      spoken = `${b.customerName}, ${b.service.name}, ${STATUS[b.status]}`;
    } else if (c.kind === 'free') {
      name = 'Free'; meta = 'Open for booking'; tag = ''; spoken = 'free';
    } else if (c.kind === 'closed') {
      name = 'Closed'; meta = c.block.reason || (c.block.period === 'all' ? 'Whole day closed' : 'Not bookable'); tag = ''; spoken = 'closed';
    } else if (c.kind === 'past') {
      name = '—'; meta = 'Past'; tag = ''; spoken = 'in the past';
    } else {
      name = 'Closed'; meta = 'Not running'; tag = ''; spoken = 'not running';
    }
    return el('button', {
      class: cls,
      type: 'button',
      'aria-pressed': String(Boolean(sel)),
      'aria-label': `${fmt.long(date)}, ${period.label}: ${spoken}`,
      onclick: () => {
        this.selected = { date, period: period.code };
        this.render();
        const panel = this.root.querySelector('aside');
        if (panel && window.matchMedia('(max-width: 1180px)').matches) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
    }, el('span', { class: 'adm-cell-name', text: name }), el('span', { class: 'adm-cell-meta', text: meta }), tag ? el('span', { class: 'adm-cell-tag', text: tag }) : null);
  },

  goWeek(monday) {
    location.hash = `bookings?date=${monday}`;
  },
  goTo(booking) {
    location.hash = `bookings?date=${booking.date}&ref=${enc(booking.reference)}&t=${Date.now()}`;
  },

  detailPanel() {
    if (!this.selected) {
      return el('div', { class: 'adm-card' }, el('p', { class: 'adm-note', text: 'Select a slot to see the booking, or to close or reopen it.' }));
    }
    const period = this.data.periods.find((p) => p.code === this.selected.period);
    if (!period) return el('div', { class: 'adm-card' }, el('p', { class: 'adm-note', text: 'That slot is no longer offered.' }));
    const c = this.cell(this.selected.date, period);
    const when = `${fmt.long(this.selected.date)} · ${period.label}`;
    if (c.kind === 'booking') return this.bookingPanel(c.booking);
    if (c.kind === 'free') {
      return el('div', { class: 'adm-card adm-detail' },
        el('p', { class: 'panel-title', text: 'Free slot' }),
        el('h2', { class: 'adm-card-title', text: when }),
        el('div', { class: 'adm-stack' },
          btn('New booking in this slot', () => openBookingForm({ date: this.selected.date, period: period.code }, (b) => this.goTo(b)), { kind: 'gold' }),
          btn('Close this slot', (e) => this.closeSlot(e.currentTarget, period.code)),
          btn('Close the whole day', (e) => this.closeSlot(e.currentTarget, 'all'))),
        el('p', { class: 'adm-note', text: 'A closed slot shows as unavailable on the booking page straight away.' }));
    }
    if (c.kind === 'closed') {
      const whole = c.block.period === 'all';
      return el('div', { class: 'adm-card adm-detail' },
        el('p', { class: 'panel-title', text: whole ? 'Day closed' : 'Slot closed' }),
        el('h2', { class: 'adm-card-title', text: when }),
        c.block.reason ? el('p', { class: 'panel-copy', text: c.block.reason }) : null,
        btn(whole ? 'Reopen the whole day' : 'Reopen slot', (e) => busy(e.currentTarget, async () => {
          await A.removeBlock(c.block.id);
          toast(whole ? 'Day reopened.' : 'Slot reopened.');
          await this.load();
        }), { kind: 'gold' }));
    }
    return el('div', { class: 'adm-card' }, el('p', { class: 'adm-note', text: `${when}: ${c.kind === 'past' ? 'in the past.' : 'this slot does not run on this day.'}` }));
  },

  closeSlot(button, periodCode) {
    const date = this.selected.date;
    return busy(button, async () => {
      const res = await A.addBlock({ date, period: periodCode, reason: null });
      toast(res.existingBookings ? `Closed. ${plural(res.existingBookings, 'existing booking')} kept — cancel separately if needed.` : 'Closed.');
      await this.load();
    });
  },

  bookingPanel(b) {
    const ref = b.reference;
    const cached = this.details.get(ref);
    if (!cached) {
      this.details.set(ref, 'loading');
      A.booking(ref).then((res) => { this.details.set(ref, res); this.renderAside(); }, (err) => { this.details.set(ref, err); this.renderAside(); });
    }
    const detail = cached && cached !== 'loading' && !(cached instanceof Error) ? cached : null;
    const booking = detail ? detail.booking : b;
    const p = booking.price || {};
    const facts = [
      ['Service', booking.service.name],
      ['Vehicle', `${booking.vehicle}${booking.vehicleSize ? ` (${booking.vehicleSize.label})` : ''}`],
      ['Handover', booking.handover === 'collection' ? `Collection · ${booking.collectionAddress || ''}` : 'Drop off'],
      ['Phone', booking.phone],
      booking.email ? ['Email', booking.email] : null,
      p.totalEur !== null && p.totalEur !== undefined ? ['Quoted', `${p.from ? 'From ' : ''}${euro(p.totalEur)}`] : null,
      p.addons && p.addons.length ? ['Extras', p.addons.map((a) => `${a.name} (+${euro(a.priceEur)})`).join(', ')] : null,
      p.discount ? ['Discount', `${p.discount.code} (−${euro(p.discount.amountEur)})`] : null,
      p.finalEur !== null && p.finalEur !== undefined ? ['Charged', euro(p.finalEur)] : null,
      ['Deposit', `${DEPOSIT[booking.deposit.status]}${['requested', 'paid'].includes(booking.deposit.status) ? ` · ${euro(booking.deposit.amountEur)}` : ''}`],
      booking.notes ? ['Notes', booking.notes] : null,
    ].filter(Boolean);
    const contact = el('div', { class: 'adm-contact' },
      el('a', { class: 'btn btn-ghost btn-sm', href: `tel:${booking.phoneE164 || ''}` }, 'Call'),
      el('a', { class: 'btn btn-ghost btn-sm', href: `sms:${booking.phoneE164 || ''}` }, 'Text'),
      booking.email ? el('a', { class: 'btn btn-ghost btn-sm', href: `mailto:${booking.email}` }, 'Email') : null,
      isAdmin && booking.userId ? el('a', { class: 'btn btn-text btn-sm', href: `#customers?key=${enc(`user:${booking.userId}`)}` }, 'Customer') : null);

    return el('div', { class: 'adm-card adm-detail' },
      el('div', { class: 'adm-card-head' }, el('span', { class: 'adm-detail-ref', text: ref }), pill(booking.status)),
      el('div', {}, el('h2', { class: 'adm-card-title', text: booking.customerName }), el('p', { class: 'adm-note', text: `${fmt.short(booking.date)} · ${booking.period.label} · ${booking.timeLabel}` })),
      contact,
      el('dl', { class: 'facts' }, facts.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v })))),
      this.actions(booking),
      this.chargedForm(booking),
      this.noteForm(booking),
      el('div', { class: 'adm-stack' },
        el('p', { class: 'panel-title', text: 'History' }),
        cached instanceof Error ? el('p', { class: 'adm-note', text: "Couldn't load the history." })
          : !detail ? el('p', { class: 'adm-note', text: 'Loading history…' })
            : el('ul', { class: 'timeline' }, detail.events.map((e) => el('li', {},
              el('span', { class: `timeline-dot${['cancelled', 'no_show'].includes(e.type) ? ' is-ended' : ''}`, 'aria-hidden': 'true' }),
              el('span', { class: 'timeline-text' },
                el('span', {}, `${EVENT_LABELS[e.type] || e.type} ${actorLabel(e.actor)}`.trim(), e.note ? el('span', { class: 'adm-cell-sub', style: { display: 'block' }, text: e.note }) : null),
                el('time', { datetime: e.at, text: fmt.dateTime(e.at) })))))));
  },

  renderAside() {
    const aside = this.root && this.root.querySelector('aside');
    if (aside) aside.replaceChildren(this.detailPanel());
  },

  actions(b) {
    const update = (button, body, message) => busy(button, async () => {
      await A.updateBooking(b.reference, body);
      toast(message);
      refreshBadges();
      await this.load();
    });
    const list = [];
    const dep = b.deposit.status;
    if (b.status === 'pending') {
      list.push(btn('Confirm booking', (e) => update(e.currentTarget, { status: 'confirmed' }, 'Confirmed. The customer gets a text and email.'), { kind: 'gold' }));
    }
    if (b.status === 'confirmed') {
      if (dep === 'not_requested') list.push(btn(`Request ${euro(b.deposit.amountEur)} deposit`, (e) => update(e.currentTarget, { depositStatus: 'requested' }, 'Deposit requested.')));
      if (dep === 'requested') {
        list.push(btn('Mark deposit paid', (e) => update(e.currentTarget, { depositStatus: 'paid' }, 'Deposit marked as paid.')));
        list.push(btn('Waive deposit', (e) => update(e.currentTarget, { depositStatus: 'waived' }, 'Deposit waived.')));
      }
      list.push(btn('Mark completed', (e) => update(e.currentTarget, { status: 'completed' }, 'Marked completed. A thank-you email is on its way.'), { kind: 'gold' }));
      list.push(btn("Customer didn't show", async (e) => {
        const button = e.currentTarget;
        if (await confirmDialog({ title: 'Mark as missed?', text: `${b.customerName} didn't turn up for ${fmt.short(b.date)}, ${b.period.label.toLowerCase()}.`, confirmLabel: 'Mark as missed' })) {
          update(button, { status: 'no_show' }, 'Marked as missed.');
        }
      }));
    }
    if (b.status === 'no_show') list.push(btn('They came after all: mark completed', (e) => update(e.currentTarget, { status: 'completed' }, 'Marked completed.')));
    if (dep === 'paid' && b.status !== 'pending') {
      list.push(btn('Refund deposit', async (e) => {
        const button = e.currentTarget;
        if (await confirmDialog({ title: 'Refund the deposit?', text: `${euro(b.deposit.amountEur)} goes back to ${b.customerName}. Online payments are refunded through Stripe.`, confirmLabel: 'Refund', danger: true })) {
          update(button, { depositStatus: 'refunded' }, 'Refund started.');
        }
      }));
    }
    if (ACTIVE.has(b.status)) {
      list.push(btn('Cancel booking', async (e) => {
        const button = e.currentTarget;
        const reason = textareaEl({ maxlength: '500', placeholder: 'Reason (optional, shown to the customer)', class: 'input', style: { minHeight: '80px', padding: '12px' } });
        if (await confirmDialog({
          title: 'Cancel this booking?',
          text: `The slot opens up again and ${b.customerName} gets a text and email.${dep === 'paid' ? ' A deposit paid online is refunded automatically.' : ''}`,
          confirmLabel: 'Cancel booking',
          cancelLabel: 'Keep booking',
          danger: true,
          extra: reason,
        })) {
          update(button, { status: 'cancelled', note: reason.value.trim() || null }, 'Booking cancelled.');
        }
      }));
    }
    if (!list.length) return el('p', { class: 'adm-note', text: 'Nothing left to do for this booking.' });
    return el('div', { class: 'adm-stack' }, list);
  },

  chargedForm(b) {
    if (!['confirmed', 'completed'].includes(b.status)) return null;
    const form = el('form', { class: 'adm-inline-form', novalidate: true });
    const amount = inputEl({ name: 'finalPriceEur', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: b.price && b.price.totalEur !== null ? String(b.price.totalEur) : '' }, b.price ? b.price.finalEur : null);
    form.append(field('Amount charged (€)', amount, { hint: 'Optional. Used for revenue when it differs from the quote.' }), btn('Save', null, { type: 'submit' }), formNotice());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('[type="submit"]'), async () => {
        await A.updateBooking(b.reference, { finalPriceEur: num(amount.value) });
        toast('Amount saved.');
        await this.load();
      }, (err) => showApiError(form, err));
    });
    return form;
  },

  noteForm(b) {
    const form = el('form', { class: 'adm-inline-form', novalidate: true });
    const note = inputEl({ name: 'note', maxlength: '1000', placeholder: 'e.g. Dog hair in the boot', autocomplete: 'off' });
    form.append(field('Add a note', note), btn('Add', null, { type: 'submit' }), formNotice());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!note.value.trim()) return;
      busy(form.querySelector('[type="submit"]'), async () => {
        await A.updateBooking(b.reference, { note: note.value.trim() });
        toast('Note added.');
        await this.load();
      }, (err) => showApiError(form, err));
    });
    return form;
  },

  slotTimesCard() {
    const periods = [...this.data.periods].sort((a, b) => a.sort - b.sort);
    if (!isAdmin) {
      return card('Slot times', el('ul', { class: 'adm-list' }, periods.map((p) => el('li', {},
        el('span', { class: 'adm-list-title', text: p.label }),
        el('span', { class: 'adm-list-sub', text: p.startTime ? `${p.startTime.slice(0, 5)}–${(p.endTime || '').slice(0, 5)}` : 'Time to be confirmed' })))));
    }
    const form = el('form', { class: 'adm-form', novalidate: true });
    const rows = periods.map((p) => {
      const start = inputEl({ type: 'time', name: `${p.code}.startTime` }, p.startTime ? p.startTime.slice(0, 5) : '');
      const end = inputEl({ type: 'time', name: `${p.code}.endTime` }, p.endTime ? p.endTime.slice(0, 5) : '');
      return { p, start, end, node: el('div', { class: 'adm-fields' }, el('p', { class: 'adm-item-title', style: { alignSelf: 'center' }, text: p.label }), field('Start', start), field('End', end)) };
    });
    form.append(...rows.map((r) => r.node),
      el('p', { class: 'adm-note', text: `Runs ${daysLabel(periods[0] ? periods[0].daysOfWeek : [])}. Until times are set, customers see "Time to be confirmed".` }),
      formNotice(),
      el('div', {}, btn('Save times', null, { kind: 'gold', type: 'submit' })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const errors = {};
      for (const r of rows) {
        const s = r.start.value;
        const en = r.end.value;
        if (Boolean(s) !== Boolean(en)) errors[`${r.p.code}.endTime`] = 'Set both times, or neither';
        else if (s && en && en <= s) errors[`${r.p.code}.endTime`] = 'End must be after the start';
      }
      setFormError(form, '');
      if (showFieldErrors(form, errors)) return;
      let saving = null;
      busy(form.querySelector('[type="submit"]'), async () => {
        let updated = 0;
        for (const r of rows) {
          saving = r.p.code;
          const s = r.start.value || null;
          const en = r.end.value || null;
          if (s === (r.p.startTime ? r.p.startTime.slice(0, 5) : null) && en === (r.p.endTime ? r.p.endTime.slice(0, 5) : null)) continue;
          const res = await A.savePeriod(r.p.code, { label: r.p.label, startTime: s, endTime: en, daysOfWeek: r.p.daysOfWeek, active: r.p.active });
          updated += res.updatedBookings;
        }
        toast(updated ? `Times saved. ${plural(updated, 'upcoming booking')} updated.` : 'Times saved.');
        await this.load();
      }, (err) => {
        // The server names fields "startTime"/"endTime"; the inputs are named per slot ("morning.endTime").
        if (err && err.fields && saving) err.fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [`${saving}.${k}`, v]));
        return showApiError(form, err);
      });
    });
    return card('Slot times', form);
  },

  notificationsCard() {
    const h = this.data.health;
    const row = (label, x) => el('li', {},
      el('span', { class: 'adm-list-title', text: label }),
      !x.configured ? el('span', { class: 'pill pill-cancelled', text: 'Not set up' })
        : x.failed7d ? el('span', { class: 'pill pill-pending', text: `${x.failed7d} failed` }) : el('span', { class: 'pill pill-confirmed', text: 'Working' }));
    const jobs = this.data.jobs.slice(0, 8).map((j) => el('li', {},
      el('div', { class: 'adm-list-main' },
        el('span', { class: 'adm-list-title', text: JOB_LABELS[j.channel] || JOB_LABELS[j.kind] || j.kind }),
        el('span', { class: 'adm-list-sub', text: `${(j.last_error || 'Unknown error').slice(0, 140)} · ${fmt.dateTime(j.created_at)}` })),
      j.kind === 'auth.password_reset' || j.kind === 'team.invite' ? null : btn('Retry', (e) => busy(e.currentTarget, async () => {
        await A.retryJob(j.id);
        toast('Sending again.');
        await this.load();
      }))));
    const feed = this.data.integ && this.data.integ.iphoneCalendar && this.data.integ.iphoneCalendar.feedUrl;
    return card('Notifications', [
      el('ul', { class: 'adm-list' }, row('Email', h.email), row('Text messages', h.sms), row('Google Calendar', h.calendar)),
      jobs.length ? el('div', { class: 'adm-stack' }, el('p', { class: 'panel-title', text: "Messages that didn't send" }), el('ul', { class: 'adm-list' }, jobs)) : null,
      feed ? el('div', { class: 'adm-stack' },
        el('p', { class: 'panel-title', text: 'Bookings on your iPhone' }),
        el('p', { class: 'adm-note', text: 'Settings › Calendar › Accounts › Add Subscribed Calendar, then paste this link. It refreshes every 15 minutes.' }),
        el('div', { class: 'adm-copy' }, inputEl({ class: 'input', readonly: true, 'aria-label': 'Calendar link' }, feed), btn('Copy link', () => copyText(feed)))) : null,
    ]);
  },
};

// =====================================================================================
// Services & prices
// =====================================================================================

const prices = {
  d: null,
  async open(root) {
    this.root = root;
    root.replaceChildren(loadingBlock('Loading prices…'));
    try {
      this.d = draft(await A.pricing());
    } catch (err) {
      root.replaceChildren(errorBlock(err, () => this.open(root)));
      return;
    }
    this.render();
  },
  get dirty() { return Boolean(this.d && this.d.dirty); },

  render() {
    const v = this.d.value;
    const form = el('form', { class: 'adm-form', novalidate: true });
    const bar = saveBar(this.d, { onSave: (b) => this.save(b, form), onDiscard: () => { this.d.discard(); this.render(); } });
    const touch = () => bar.refresh();
    form.addEventListener('input', (e) => { if (e.target.matches('input, textarea, select')) clearFieldError(e.target); });

    const general = card('Pricing', el('div', { class: 'adm-stack' },
      switchEl('Price by vehicle size (small / large / SUV)', v.bySize, (on) => { v.bySize = on; this.render(); }),
      el('div', { class: 'adm-fields' },
        field('Deposit (€)', (() => {
          const i = inputEl({ name: 'depositEur', type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, v.depositEur);
          i.addEventListener('input', () => { v.depositEur = num(i.value) ?? 0; touch(); });
          return i;
        })(), { hint: 'Requested after you confirm a booking. 0 turns deposits off.' }))));

    const services = el('div', { class: 'adm-items' }, v.services.map((s, i) => this.serviceCard(s, i, touch)));
    const addService = btn('Add a service', () => {
      v.services.push({ code: null, name: 'New service', description: null, durationLabel: null, priceFrom: true, active: false, featured: false, prices: { small: null, large: null, suv: null }, bookings: 0 });
      this.render();
    });

    const addons = el('div', { class: 'adm-items' }, v.addons.map((a, i) => {
      const name = inputEl({ name: `addons.${i}.name`, maxlength: '60' }, a.name);
      name.addEventListener('input', () => { a.name = name.value; touch(); });
      const price = inputEl({ name: `addons.${i}.priceEur`, type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, a.priceEur);
      price.addEventListener('input', () => { a.priceEur = num(price.value); touch(); });
      return el('div', { class: 'adm-item' }, el('div', { class: 'adm-fields' },
        field('Extra', name), field('Price (+€)', price),
        el('div', { class: 'adm-row', style: { alignSelf: 'center' } },
          switchEl(`Offer ${a.name || 'this'}`, a.active, (on) => { a.active = on; touch(); }),
          btn('Remove', () => { v.addons.splice(i, 1); this.render(); }, { kind: 'text' }))));
    }));
    const addAddon = btn('Add an extra', () => { v.addons.push({ id: null, name: '', priceEur: 0, active: true }); this.render(); });

    form.append(general,
      card('Services', [services, el('div', {}, addService)], { actions: [el('a', { class: 'link-arrow', href: '#discounts?tab=sales' }, 'Sale prices & codes')] }),
      card('Extras', [v.addons.length ? addons : el('p', { class: 'adm-note', text: 'Optional add-ons customers can tick when booking, like pet hair removal.' }), el('div', {}, addAddon)]),
      formNotice());
    this.root.replaceChildren(head('h-prices', 'Services & prices', 'Changes show on the website and booking page as soon as you save.'), form, bar.el);
  },

  serviceCard(s, i, touch) {
    const v = this.d.value;
    const bind = (node, key, map = (x) => x) => {
      node.addEventListener('input', () => { s[key] = map(node.value); touch(); });
      return node;
    };
    const price = (size, label) => {
      const n = inputEl({ name: `services.${i}.prices.${size}`, type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, s.prices[size]);
      n.addEventListener('input', () => { s.prices[size] = num(n.value); touch(); });
      return field(label, n);
    };
    const move = (delta) => {
      const j = i + delta;
      if (j < 0 || j >= v.services.length) return;
      [v.services[i], v.services[j]] = [v.services[j], v.services[i]];
      this.render();
    };
    return el('div', { class: `adm-item${s.active ? '' : ' is-off'}` },
      el('div', { class: 'adm-item-head' },
        el('div', { class: 'adm-row' }, el('span', { class: 'adm-num', text: String(i + 1).padStart(2, '0') }), el('span', { class: 'adm-item-title', text: s.name || 'Untitled service' })),
        el('div', { class: 'adm-order' },
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move ${s.name} up`, disabled: i === 0, onclick: () => move(-1) }, icon('M18 15l-6-6-6 6')),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move ${s.name} down`, disabled: i === v.services.length - 1, onclick: () => move(1) }, icon(ICONS.chevronDown)))),
      el('div', { class: 'adm-fields' },
        field('Service name', bind(inputEl({ name: `services.${i}.name`, maxlength: '60' }, s.name), 'name')),
        field('Duration', bind(inputEl({ name: `services.${i}.durationLabel`, maxlength: '40', placeholder: 'e.g. Approx. 2 hours' }, s.durationLabel), 'durationLabel', (x) => x || null))),
      field('Description', bind(textareaEl({ name: `services.${i}.description`, maxlength: '500' }, s.description), 'description', (x) => x || null)),
      el('div', { class: 'adm-fields' },
        v.bySize ? [price('small', 'Small / medium (€)'), price('large', 'Large / estate (€)'), price('suv', 'SUV / van (€)')] : price('small', 'Price (€)')),
      el('div', { class: 'adm-row' },
        switchEl('Bookable online', s.active, (on) => { s.active = on; touch(); }),
        switchEl('Signature badge', s.featured, (on) => { s.featured = on; touch(); }),
        checkEl('Show as "From" price', s.priceFrom, (on) => { s.priceFrom = on; touch(); })),
      el('p', { class: 'adm-note', text: s.code ? (s.bookings ? `${plural(s.bookings, 'booking')} so far` : 'Not booked yet') : 'New — not saved yet' }));
  },

  save(button, form) {
    const v = this.d.value;
    const body = {
      bySize: v.bySize,
      depositEur: v.depositEur,
      services: v.services.map(({ code, name, description, durationLabel, priceFrom, active, featured, prices: p }) => ({ code, name, description, durationLabel, priceFrom, active, featured, prices: p })),
      addons: v.addons.map(({ id, name, priceEur, active }) => ({ id, name, priceEur, active })),
    };
    setFormError(form, '');
    busy(button, async () => {
      this.d.reset(await A.savePricing(body));
      toast('Prices saved.');
      this.render();
    }, (err) => showApiError(form, err));
  },
};

// =====================================================================================
// Discounts (codes + sale prices)
// =====================================================================================

const DISCOUNT_STATUS = { active: ['confirmed', 'Active'], scheduled: ['pending', 'Scheduled'], paused: ['cancelled', 'Paused'], expired: ['cancelled', 'Expired'], used_up: ['cancelled', 'Used up'] };
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const discounts = {
  tab: 'codes',
  async open(root, params) {
    this.root = root;
    this.tab = params.get('tab') === 'sales' ? 'sales' : 'codes';
    root.replaceChildren(loadingBlock('Loading discounts…'));
    try {
      const [list, pricing, sales] = await Promise.all([A.discounts(), A.pricing(), A.sales()]);
      this.list = list;
      this.services = pricing.services;
      this.sales = draft(sales);
    } catch (err) {
      root.replaceChildren(errorBlock(err, () => this.open(root, params)));
      return;
    }
    this.render();
  },
  get dirty() { return Boolean(this.tab === 'sales' && this.sales && this.sales.dirty); },

  render() {
    const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Discount type' },
      [['codes', 'Discount codes'], ['sales', 'Sale prices']].map(([key, label]) => el('button', {
        class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(this.tab === key), onclick: () => { location.hash = `discounts?tab=${key}`; },
      }, label)));
    const body = this.tab === 'codes' ? this.codesView() : this.salesView();
    this.root.replaceChildren(
      head('h-discounts', 'Discounts', 'Codes customers type at booking, and dated sale prices shown on the website.', this.tab === 'codes' ? [btn('New discount code', () => this.form(null), { kind: 'gold' })] : []),
      tabs, ...[].concat(body));
  },

  codesView() {
    const { discounts: list, stats } = this.list;
    const names = new Map(this.services.map((s) => [s.code, s.name]));
    const applies = (d) => {
      const active = this.services.filter((s) => s.active).map((s) => s.code);
      const all = active.every((c) => d.serviceCodes.includes(c));
      const base = all ? 'All services' : d.serviceCodes.map((c) => names.get(c) || c).join(', ');
      return [base, d.firstBookingOnly ? 'first booking' : null, d.onePerCustomer ? 'once per customer' : null].filter(Boolean).join(' · ');
    };
    const rows = list.map((d) => {
      const [cls, label] = DISCOUNT_STATUS[d.status] || ['completed', d.status];
      const canToggle = ['active', 'paused', 'scheduled'].includes(d.status);
      return el('tr', {},
        el('td', {}, el('div', { class: 'adm-cell-main' }, el('strong', { text: d.code }), el('span', { class: 'adm-cell-sub', text: applies(d) }))),
        el('td', { text: d.label }),
        el('td', { text: d.endsOn ? `${fmt.short(d.startsOn)} – ${fmt.short(d.endsOn)}` : `${fmt.short(d.startsOn)} onwards` }),
        el('td', { class: 'num', text: d.maxUses ? `${d.uses} / ${d.maxUses}` : String(d.uses) }),
        el('td', {}, pill(cls, label)),
        el('td', { class: 'right' }, el('div', { class: 'adm-actions', style: { justifyContent: 'flex-end' } },
          btn('Edit', () => this.form(d), { kind: 'text' }),
          canToggle ? btn(d.paused ? 'Resume' : 'Pause', (e) => busy(e.currentTarget, async () => {
            await A.pauseDiscount(d.id, !d.paused);
            toast(d.paused ? `${d.code} resumed.` : `${d.code} paused.`);
            this.list = await A.discounts();
            this.render();
          }), { kind: 'text' }) : null)));
    });
    return [
      el('div', { class: 'adm-tiles' },
        tile('Active codes', String(stats.activeCodes), { sub: `${plural(stats.totalCodes, 'code')} in total` }),
        tile('Times used', String(stats.timesUsed), { sub: 'Across all codes' }),
        tile('Discount given', euro(stats.discountGivenEur), { sub: 'All time' }),
        tile('Bookings with a code', `${stats.bookingsWithCodePct30d}%`, { sub: 'Last 30 days' })),
      list.length
        ? card(null, el('div', { class: 'adm-table-wrap' }, el('table', { class: 'adm-table' },
          el('thead', {}, el('tr', {}, ['Code', 'Discount', 'Valid', 'Used', 'Status', ''].map((h, i) => el('th', { class: i === 3 ? 'num' : '', text: h })))),
          el('tbody', {}, rows))))
        : empty('No discount codes yet. Create one for a promotion or a loyal customer.'),
    ];
  },

  form(existing) {
    const today = todayIso();
    const d = existing || { code: '', kind: 'percent', value: 10, serviceCodes: this.services.filter((s) => s.active).map((s) => s.code), startsOn: today, endsOn: null, maxUses: null, firstBookingOnly: false, onePerCustomer: true };
    const form = el('form', { class: 'adm-form', novalidate: true });
    const code = inputEl({ name: 'code', maxlength: '20', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'e.g. SPRING15', style: { textTransform: 'uppercase', letterSpacing: '.08em' } }, d.code);
    const generate = btn('Generate', () => {
      const pick = () => CODE_CHARS[crypto.getRandomValues(new Uint32Array(1))[0] % CODE_CHARS.length];
      code.value = `SJP${Array.from({ length: 6 }, pick).join('')}`;
      clearFieldError(code);
      preview();
    });
    const kind = selectEl({ name: 'kind' }, [['percent', '% off'], ['fixed', '€ off']], d.kind);
    const value = inputEl({ name: 'value', type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, d.value);
    const serviceBoxes = this.services.map((s) => checkEl(`${s.name}${s.prices.small !== null ? ` · ${euro(s.prices.small)}` : ''}${s.active ? '' : ' (hidden)'}`, d.serviceCodes.includes(s.code), null, { name: 'serviceCodes', value: s.code }));
    const starts = inputEl({ name: 'startsOn', type: 'date' }, d.startsOn);
    const ends = inputEl({ name: 'endsOn', type: 'date' }, d.endsOn);
    const maxUses = inputEl({ name: 'maxUses', type: 'number', min: '1', step: '1', placeholder: 'No limit' }, d.maxUses);
    const onePer = checkEl('One use per customer', d.onePerCustomer, null, { name: 'onePerCustomer' });
    const firstOnly = checkEl('First booking only', d.firstBookingOnly, null, { name: 'firstBookingOnly' });
    const example = el('p', { class: 'notice notice-gold' });
    const preview = () => {
      const chosen = this.services.find((s) => form.querySelector(`input[name="serviceCodes"][value="${CSS.escape(s.code)}"]:checked`) && s.prices.small !== null);
      const v = Number(value.value) || 0;
      const label = (code.value || 'CODE').toUpperCase();
      if (!chosen || !v) { example.textContent = 'Pick a service and an amount to see an example.'; return; }
      const base = chosen.prices.small;
      const off = kind.value === 'percent' ? Math.round(base * v) / 100 : Math.min(v, base);
      example.textContent = `Example — ${chosen.name}: ${euro(base)} → ${euro(Math.round((base - off) * 100) / 100)} with ${label}`;
    };
    form.append(
      el('div', { class: 'adm-inline-form' }, field('Code', code, { hint: '3–20 letters and numbers' }), generate),
      el('div', { class: 'adm-fields' }, field('Discount type', kind), field('Amount', value, { hint: '% off: whole number up to 90' })),
      el('fieldset', { style: { border: '0', padding: '0', margin: '0' } }, el('legend', { class: 'label', text: 'Applies to' }), el('div', { class: 'adm-checks' }, serviceBoxes),
        el('span', { class: 'error', 'data-for': 'serviceCodes' })),
      el('div', { class: 'adm-fields' }, field('Starts', starts), field('Ends (optional)', ends), field('Total uses allowed (optional)', maxUses)),
      el('div', { class: 'adm-checks' }, onePer, firstOnly),
      example,
      formNotice(),
      el('div', { class: 'adm-dialog-actions' }, btn('Cancel', () => modal.close()), btn(existing ? 'Save changes' : 'Create code', null, { kind: 'gold', type: 'submit' })));
    form.addEventListener('input', (e) => { if (e.target.matches('input, select')) clearFieldError(e.target); preview(); });
    preview();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = {
        code: code.value.trim(),
        kind: kind.value,
        value: Number(value.value),
        serviceCodes: [...form.querySelectorAll('input[name="serviceCodes"]:checked')].map((c) => c.value),
        startsOn: starts.value,
        endsOn: ends.value || null,
        maxUses: num(maxUses.value),
        onePerCustomer: form.querySelector('input[name="onePerCustomer"]').checked,
        firstBookingOnly: form.querySelector('input[name="firstBookingOnly"]').checked,
      };
      setFormError(form, '');
      busy(form.querySelector('[type="submit"]'), async () => {
        const { discount } = existing ? await A.updateDiscount(existing.id, body) : await A.createDiscount(body);
        modal.close();
        toast(existing ? `${discount.code} saved.` : `${discount.code} created.`);
        this.list = await A.discounts();
        this.render();
      }, (err) => showApiError(form, err));
    });
    modal.open(existing ? `Edit ${existing.code}` : 'New discount code', form);
  },

  salesView() {
    const v = this.sales.value;
    const form = el('form', { class: 'adm-form', novalidate: true });
    const bar = saveBar(this.sales, { onSave: (b) => this.saveSales(b, form), onDiscard: () => { this.sales.discard(); this.render(); } });
    form.addEventListener('input', (e) => { if (e.target.matches('input')) clearFieldError(e.target); bar.refresh(); });
    const today = todayIso();
    const cards = v.services.filter((s) => s.priceEur !== null).map((s) => {
      const i = v.services.indexOf(s);
      const sale = s.sale;
      const price = inputEl({ name: `sales.${i}.priceEur`, type: 'number', min: '0', step: '0.01', inputmode: 'decimal' }, sale.priceEur);
      price.addEventListener('input', () => { sale.priceEur = num(price.value); });
      const from = inputEl({ name: `sales.${i}.startsOn`, type: 'date' }, sale.startsOn);
      from.addEventListener('input', () => { sale.startsOn = from.value || null; });
      const until = inputEl({ name: `sales.${i}.endsOn`, type: 'date' }, sale.endsOn);
      until.addEventListener('input', () => { sale.endsOn = until.value || null; });
      const pct = sale.priceEur !== null && s.priceEur ? Math.round((1 - sale.priceEur / s.priceEur) * 100) : null;
      const note = !sale.enabled ? 'No sale.' : s.status === 'live' ? `${pct}% off · live now${sale.endsOn ? ` until ${fmt.short(sale.endsOn)}` : ''}`
        : s.status === 'scheduled' ? `Scheduled from ${fmt.short(sale.startsOn)}` : sale.endsOn && sale.endsOn < today ? 'Ended' : 'Saved — check the dates';
      return el('div', { class: `adm-item${sale.enabled ? '' : ' is-off'}` },
        el('div', { class: 'adm-item-head' }, el('span', { class: 'adm-item-title', text: s.name }),
          switchEl('On sale', sale.enabled, (on) => { sale.enabled = on; this.render(); })),
        el('div', { class: 'adm-fields' },
          el('div', { class: 'field' }, el('span', { text: 'Normal price' }), el('strong', { style: { fontSize: '20px', color: 'var(--ivory)', letterSpacing: '0', textTransform: 'none' }, text: euro(s.priceEur) })),
          field('Sale price (€)', price), field('From', from), field('Until', until)),
        el('p', { class: 'adm-note', text: note }));
    });
    form.append(cards.length ? el('div', { class: 'adm-items' }, cards) : empty('Set prices on the Services & prices page first.'), formNotice());
    return [form, bar.el];
  },

  saveSales(button, form) {
    const body = { sales: this.sales.value.services.map((s) => ({ code: s.code, enabled: s.sale.enabled, priceEur: s.sale.priceEur, startsOn: s.sale.startsOn, endsOn: s.sale.endsOn })) };
    setFormError(form, '');
    busy(button, async () => {
      this.sales.reset(await A.saveSales(body));
      toast('Sale prices saved.');
      this.render();
    }, (err) => showApiError(form, err));
  },
};

// =====================================================================================
// Photos (slideshow, gallery, before & after)
// =====================================================================================

const CATEGORIES = [['exterior', 'Exterior'], ['interior', 'Interior'], ['wheels', 'Wheels'], ['detail', 'Detail']];
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const thumb = (image) => (image && image.sizes && image.sizes[0] ? image.sizes[0].url : (image && image.src) || '');
/** 'spring-wash_01.jpg' → 'Spring wash 01'; camera names like IMG_1234 give no caption. */
function captionFrom(file) {
  const base = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  if (!base || /^(img|dsc|dcim|pxl|photo|image)\s?\d*/i.test(base)) return null;
  return (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 120);
}
/** Upload files one at a time (each is resized on the server); failures are reported per file. */
async function uploadAll(files, progress) {
  const done = [];
  const list = [...files];
  for (const [i, file] of list.entries()) {
    progress.textContent = `Uploading ${i + 1} of ${list.length}: ${file.name}…`;
    try {
      const { image } = await A.upload(file);
      done.push({ image, file });
    } catch (err) {
      if (err.code === 'UNAUTHENTICATED') { handleError(err); break; }
      toast(`${file.name}: ${err.message}`, { error: true });
    }
  }
  progress.textContent = '';
  return done;
}
function uploadButton(label, { multiple = false, onFiles }) {
  const input = el('input', { type: 'file', accept: ACCEPT, multiple, 'aria-label': label });
  input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); input.value = ''; });
  return el('span', { class: 'btn btn-gold btn-sm adm-upload' }, label, input);
}

const photos = {
  tab: 'slides',
  filter: 'all',
  async open(root, params) {
    this.root = root;
    this.tab = ['slides', 'gallery', 'pairs'].includes(params.get('tab')) ? params.get('tab') : this.tab;
    root.replaceChildren(loadingBlock('Loading photos…'));
    try {
      const [slides, gallery, pairs] = await Promise.all([A.slides(), A.photos(), A.pairs()]);
      this.slides = draft(slides);
      this.gallery = gallery;
      this.pairs = pairs.pairs;
    } catch (err) {
      root.replaceChildren(errorBlock(err, () => this.open(root, params)));
      return;
    }
    this.render();
  },
  get dirty() { return Boolean(this.slides && this.slides.dirty); },

  render() {
    const counts = { slides: this.slides.value.slides.length, gallery: this.gallery.counts.all, pairs: this.pairs.length };
    const tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Photo area' },
      [['slides', 'Homepage slideshow'], ['gallery', 'Gallery'], ['pairs', 'Before & after']].map(([key, label]) => el('button', {
        class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(this.tab === key),
        onclick: async () => {
          if (this.tab === 'slides' && key !== 'slides' && this.dirty && !(await confirmDialog({ title: 'Leave without publishing?', text: 'Your slideshow changes will be lost.', confirmLabel: 'Leave', danger: true }))) return;
          if (key !== 'slides') this.slides.discard();
          location.hash = `photos?tab=${key}`;
        },
      }, label, el('span', { class: 'count', text: String(counts[key]) }))));
    const view = this.tab === 'slides' ? this.slidesView() : this.tab === 'gallery' ? this.galleryView() : this.pairsView();
    this.root.replaceChildren(head('h-photos', 'Photos', 'Photos are resized automatically, and location data from phones is removed.', [el('a', { class: 'btn btn-ghost btn-sm', href: 'index.html', target: '_blank', rel: 'noopener' }, 'Preview homepage')]), tabs, ...[].concat(view));
  },

  slidesView() {
    const v = this.slides.value;
    const form = el('form', { class: 'adm-form', novalidate: true });
    const bar = saveBar(this.slides, { label: 'Slideshow changes not published yet', onSave: (b) => this.publish(b, form), onDiscard: () => { this.slides.discard(); this.render(); } });
    bar.el.querySelector('.btn-gold').firstChild.textContent = 'Publish slideshow';
    form.addEventListener('input', (e) => { if (e.target.matches('input, textarea')) clearFieldError(e.target); bar.refresh(); summary(); });
    const progress = el('p', { class: 'adm-progress', role: 'status' });
    const summaryEl = el('p', { class: 'adm-note' });
    const summary = () => {
      const showing = v.slides.filter((s) => s.visible).length;
      summaryEl.textContent = `${showing} of ${v.slides.length} slides showing · each for ${v.seconds} seconds`;
    };
    summary();
    const secondsInput = inputEl({ name: 'seconds', type: 'number', min: '3', max: '10', step: '1' }, v.seconds);
    secondsInput.addEventListener('input', () => { v.seconds = Number(secondsInput.value) || 5; });

    const rows = v.slides.map((s, i) => {
      const caption = inputEl({ name: `slides.${i}.caption`, maxlength: '120', placeholder: 'Caption on slide (optional)' }, s.caption);
      caption.addEventListener('input', () => { s.caption = caption.value.trim() || null; });
      const alt = inputEl({ name: `slides.${i}.alt`, maxlength: '200', placeholder: 'Describe the photo for screen readers' }, s.alt);
      alt.addEventListener('input', () => { s.alt = alt.value.trim() || null; });
      const move = (delta) => {
        const j = i + delta;
        if (j < 0 || j >= v.slides.length) return;
        [v.slides[i], v.slides[j]] = [v.slides[j], v.slides[i]];
        this.render();
      };
      return el('div', { class: `adm-item adm-slide${s.visible ? '' : ' is-off'}` },
        el('div', { class: 'adm-photo-img' }, el('img', { src: thumb(s.image), alt: '', loading: 'lazy' })),
        el('div', { class: 'adm-stack' }, field('Caption', caption), field('Description (required to show)', alt)),
        el('div', { class: 'adm-stack', style: { alignItems: 'flex-end' } },
          el('div', { class: 'adm-order' },
            el('span', { class: 'adm-num', text: String(i + 1).padStart(2, '0') }),
            el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move slide up', disabled: i === 0, onclick: () => move(-1) }, icon('M18 15l-6-6-6 6')),
            el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move slide down', disabled: i === v.slides.length - 1, onclick: () => move(1) }, icon(ICONS.chevronDown))),
          switchEl(s.visible ? 'Showing' : 'Hidden', s.visible, (on) => { s.visible = on; this.render(); }),
          btn('Remove', async (e) => {
            const button = e.currentTarget;
            if (!(await confirmDialog({ title: 'Remove this slide?', text: 'The photo is deleted from the slideshow straight away.', confirmLabel: 'Remove', danger: true }))) return;
            busy(button, async () => {
              const keep = this.slides.value;
              const fresh = await A.removeSlide(s.id);
              this.mergeSlides(fresh, keep);
              toast('Slide removed.');
              this.render();
            });
          }, { kind: 'text' })));
    });

    form.append(
      card(null, [
        el('div', { class: 'adm-row' },
          uploadButton('Add a slide', { onFiles: (files) => this.addSlides(files, progress) }),
          el('div', { class: 'grow' }, field('Seconds per slide', secondsInput)),
          summaryEl),
        progress,
        el('p', { class: 'adm-note', text: 'New slides start hidden. Use a wide JPG, PNG or WebP photo, at least 1600px across for a sharp result.' }),
      ]),
      rows.length ? el('div', { class: 'adm-items' }, rows) : empty('No slides yet. The homepage shows the built-in photos until you publish your own.'),
      formNotice());
    return [form, bar.el];
  },

  /** Keep unsaved edits to slides that still exist when the server sends a fresh list. */
  mergeSlides(fresh, local) {
    const byId = new Map(local.slides.map((s) => [s.id, s]));
    const merged = { seconds: local.seconds, slides: fresh.slides.map((s) => byId.get(s.id) || s) };
    this.slides.reset(fresh);
    this.slides.value = merged;
  },

  async addSlides(files, progress) {
    const local = this.slides.value;
    const done = await uploadAll(files, progress);
    if (!done.length) return;
    try {
      let fresh = null;
      for (const { image, file } of done) fresh = await A.addSlide({ imageId: image.id, caption: captionFrom(file) });
      this.mergeSlides(fresh, local);
      toast(done.length === 1 ? 'Slide added (hidden until you publish).' : `${done.length} slides added (hidden until you publish).`);
      this.render();
    } catch (err) {
      handleError(err);
    }
  },

  publish(button, form) {
    const v = this.slides.value;
    setFormError(form, '');
    busy(button, async () => {
      this.slides.reset(await A.publishSlides({ seconds: v.seconds, slides: v.slides.map((s) => ({ id: s.id, caption: s.caption, alt: s.alt, visible: s.visible })) }));
      toast('Slideshow published.');
      this.render();
    }, (err) => showApiError(form, err));
  },

  galleryView() {
    const { photos: list, counts } = this.gallery;
    const progress = el('p', { class: 'adm-progress', role: 'status' });
    const chips = el('div', { class: 'adm-chips', role: 'group', 'aria-label': 'Filter by category' },
      [['all', 'All'], ...CATEGORIES].map(([key, label]) => el('button', {
        class: 'adm-chip', type: 'button', 'aria-pressed': String(this.filter === key), onclick: () => { this.filter = key; this.render(); },
      }, label, el('span', { class: 'count', text: String(counts[key] || 0) }))));
    const shown = list.filter((p) => this.filter === 'all' || p.category === this.filter);
    const reload = async () => { this.gallery = await A.photos(); this.render(); };
    const cards = shown.map((p) => {
      const caption = inputEl({ class: 'input', maxlength: '120', placeholder: 'Caption', 'aria-label': 'Caption' }, p.caption);
      caption.addEventListener('change', () => busy(null, async () => {
        await A.updatePhoto(p.id, { caption: caption.value.trim() || null });
        p.caption = caption.value.trim() || null;
        toast('Caption saved.');
      }));
      const category = selectEl({ class: 'input', 'aria-label': 'Category' }, CATEGORIES, p.category);
      category.addEventListener('change', () => busy(null, async () => {
        await A.updatePhoto(p.id, { category: category.value });
        await reload();
      }));
      return el('div', { class: 'adm-photo' },
        el('div', { class: 'adm-photo-img' }, el('img', { src: thumb(p.image), alt: p.caption || 'Gallery photo', loading: 'lazy' })),
        el('div', { class: 'adm-photo-body' }, caption, category,
          el('div', { class: 'adm-photo-actions' },
            el('button', { class: 'btn btn-ghost btn-sm adm-star', type: 'button', 'aria-pressed': String(p.featured), title: 'Show on homepage',
              onclick: (e) => busy(e.currentTarget, async () => {
                await A.updatePhoto(p.id, { featured: !p.featured });
                toast(p.featured ? 'Removed from the homepage.' : 'Shown on the homepage.');
                await reload();
              }) }, p.featured ? '★ On homepage' : '☆ Homepage'),
            btn('Delete', async (e) => {
              const button = e.currentTarget;
              if (!(await confirmDialog({ title: 'Delete this photo?', text: 'It disappears from the gallery straight away.', confirmLabel: 'Delete', danger: true }))) return;
              busy(button, async () => { await A.removePhoto(p.id); toast('Photo deleted.'); await reload(); });
            }, { kind: 'text' }))));
    });
    const upload = uploadButton('Upload photos', {
      multiple: true,
      onFiles: async (files) => {
        const done = await uploadAll(files, progress);
        if (!done.length) return;
        const category = this.filter === 'all' ? 'exterior' : this.filter;
        busy(null, async () => {
          this.gallery = await A.addPhotos(done.map(({ image, file }) => ({ imageId: image.id, caption: captionFrom(file), category })));
          toast(`${plural(done.length, 'photo')} added to ${CATEGORIES.find(([k]) => k === category)[1]}.`);
          this.render();
        });
      },
    });
    return [
      el('div', { class: 'adm-toolbar', style: { justifyContent: 'space-between' } }, chips, upload),
      progress,
      el('p', { class: 'adm-note', text: 'Star a photo to show it on the homepage. New uploads go into the category you are viewing (Exterior when viewing All).' }),
      cards.length ? el('div', { class: 'adm-photos' }, cards) : empty(list.length ? 'No photos in this category.' : 'No photos yet. The gallery page shows the built-in photos until you add your own.'),
    ];
  },

  pairsView() {
    const progress = el('p', { class: 'adm-progress', role: 'status' });
    const form = el('form', { class: 'adm-form', novalidate: true });
    const title = inputEl({ name: 'title', maxlength: '120', placeholder: 'e.g. Muddy SUV, full valet' });
    const before = el('input', { type: 'file', accept: ACCEPT, name: 'before', 'aria-label': 'Before photo' });
    const after = el('input', { type: 'file', accept: ACCEPT, name: 'after', 'aria-label': 'After photo' });
    form.append(
      el('div', { class: 'adm-fields' }, field('Title', title), field('Before photo', before), field('After photo', after)),
      progress, formNotice(),
      el('div', {}, btn('Add pair', null, { kind: 'gold', type: 'submit' })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const errors = {};
      if (title.value.trim().length < 2) errors.title = 'Add a short title';
      if (!before.files.length) errors.before = 'Choose the before photo';
      if (!after.files.length) errors.after = 'Choose the after photo';
      setFormError(form, '');
      if (showFieldErrors(form, errors)) return;
      busy(form.querySelector('[type="submit"]'), async () => {
        const [b] = await uploadAll(before.files, progress);
        const [a] = b ? await uploadAll(after.files, progress) : [];
        if (!b || !a) return;
        const res = await A.addPair({ title: title.value.trim(), beforeImageId: b.image.id, afterImageId: a.image.id });
        this.pairs = res.pairs;
        toast('Pair added. Publish it to show it on the homepage.');
        this.render();
      }, (err) => showApiError(form, err));
    });
    const cards = this.pairs.map((p) => {
      const name = inputEl({ class: 'input', maxlength: '120', 'aria-label': 'Title' }, p.title);
      name.addEventListener('change', () => busy(null, async () => {
        if (name.value.trim().length < 2) { toast('Titles need at least 2 characters.', { error: true }); name.value = p.title; return; }
        this.pairs = (await A.updatePair(p.id, { title: name.value.trim() })).pairs;
        toast('Title saved.');
      }));
      return el('div', { class: 'adm-photo' },
        el('div', { class: 'adm-pair-imgs' },
          el('figure', {}, el('div', { class: 'adm-photo-img' }, el('img', { src: thumb(p.before), alt: `Before: ${p.title}`, loading: 'lazy' })), el('figcaption', { text: 'Before' })),
          el('figure', {}, el('div', { class: 'adm-photo-img' }, el('img', { src: thumb(p.after), alt: `After: ${p.title}`, loading: 'lazy' })), el('figcaption', { text: 'After' }))),
        el('div', { class: 'adm-photo-body' }, name,
          el('div', { class: 'adm-photo-actions' },
            p.published ? el('span', { class: 'pill pill-confirmed', text: 'On homepage' }) : el('span', { class: 'pill pill-cancelled', text: 'Hidden' }),
            el('div', { class: 'adm-actions' },
              btn(p.published ? 'Hide' : 'Publish', (e) => busy(e.currentTarget, async () => {
                this.pairs = (await A.updatePair(p.id, { published: !p.published })).pairs;
                toast(p.published ? 'Hidden from the homepage.' : 'Now on the homepage.');
                this.render();
              }), { kind: p.published ? 'ghost' : 'gold' }),
              btn('Delete', async (e) => {
                const button = e.currentTarget;
                if (!(await confirmDialog({ title: 'Delete this pair?', text: 'Both photos are deleted.', confirmLabel: 'Delete', danger: true }))) return;
                busy(button, async () => { this.pairs = (await A.removePair(p.id)).pairs; toast('Pair deleted.'); this.render(); });
              }, { kind: 'text' })))));
    });
    return [
      card('Add a before & after pair', form),
      el('p', { class: 'adm-note', text: 'Only one pair shows on the homepage at a time: publishing one hides the others.' }),
      cards.length ? el('div', { class: 'adm-photos' }, cards) : empty('No pairs yet. The homepage shows the built-in example until you publish one.'),
    ];
  },
};

// =====================================================================================
// Customers
// =====================================================================================

const customers = {
  q: '',
  type: 'all',
  sort: 'recent',
  key: null,
  async open(root, params) {
    this.root = root;
    if (params.get('key')) this.key = params.get('key');
    root.replaceChildren(loadingBlock('Loading customers…'));
    await this.load();
  },
  query() {
    const p = new URLSearchParams({ type: this.type, sort: this.sort });
    if (this.q.trim()) p.set('q', this.q.trim());
    return p.toString();
  },
  async load() {
    try {
      this.data = await A.customers(this.query());
    } catch (err) {
      this.root.replaceChildren(errorBlock(err, () => this.load()));
      return;
    }
    this.render();
    if (this.key) this.openDetail(this.key);
  },

  render() {
    const { stats, customers: list, shown, total } = this.data;
    const search = inputEl({ class: 'input', type: 'search', placeholder: 'Search by name, email or phone', 'aria-label': 'Search customers', autocomplete: 'off' }, this.q);
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        this.q = search.value;
        const pos = search.selectionStart;
        await this.load();
        const again = this.root.querySelector('input[type="search"]');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      }, 250);
    });
    const sort = selectEl({ class: 'input', 'aria-label': 'Sort customers' }, [['recent', 'Last valet'], ['bookings', 'Most bookings'], ['spent', 'Highest spend'], ['name', 'Name']], this.sort);
    sort.addEventListener('change', () => { this.sort = sort.value; this.load(); });
    const rows = list.map((c) => el('tr', { class: 'is-clickable', 'aria-selected': String(c.key === this.key), onclick: () => this.openDetail(c.key) },
      el('td', {}, el('button', { class: 'adm-row-btn', type: 'button', onclick: (e) => { e.stopPropagation(); this.openDetail(c.key); } },
        el('span', { class: 'adm-cell-main' }, el('strong', { text: c.name }), el('span', { class: 'adm-cell-sub', text: c.email || c.phone })))),
      el('td', { text: c.type === 'account' ? 'Account' : 'Guest' }),
      el('td', { class: 'num', text: String(c.bookings) }),
      el('td', { class: 'num', text: euro(c.spentEur) }),
      el('td', { text: relDay(c.lastValet) })));
    this.root.replaceChildren(
      head('h-customers', 'Customers', 'Everyone who has booked, with or without an account.', [
        btn('Export CSV', (e) => busy(e.currentTarget, async () => {
          const blob = await A.customersCsv(this.query());
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: `customers-${todayIso()}.csv` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          toast('Exported.');
        })),
      ]),
      el('div', { class: 'adm-tiles' },
        tile('Total customers', String(stats.total)),
        tile('With an account', String(stats.accounts), { sub: `${stats.accountsPct}% of customers` }),
        tile('Guests', String(stats.guests), { sub: 'Booked without signing up' }),
        tile('Returning', `${stats.returningPct}%`, { sub: `${stats.returning} booked 2+ times` }),
        tile('New in 30 days', String(stats.new30d))),
      el('div', { class: 'adm-split' },
        el('div', { class: 'adm-card' },
          el('div', { class: 'adm-toolbar' }, search,
            seg([['all', 'All'], ['account', 'Accounts'], ['guest', 'Guests'], ['returning', 'Returning']], this.type, (t) => { this.type = t; this.load(); }, 'Customer type'),
            sort),
          rows.length
            ? el('div', { class: 'adm-table-wrap' }, el('table', { class: 'adm-table' },
              el('thead', {}, el('tr', {}, ['Customer', 'Type', 'Bookings', 'Spent', 'Last valet'].map((h, i) => el('th', { class: i === 2 || i === 3 ? 'num' : '', text: h })))),
              el('tbody', {}, rows)))
            : empty(this.q ? `No customers match "${this.q}".` : 'No customers yet.'),
          el('p', { class: 'adm-note', text: `Showing ${shown} of ${total} customers` })),
        el('aside', { 'aria-label': 'Customer details' }, el('div', { class: 'adm-card' }, el('p', { class: 'adm-note', text: 'Select a customer to see their bookings and notes.' })))));
  },

  async openDetail(key) {
    this.key = key;
    this.root.querySelectorAll('tbody tr').forEach((tr, i) => tr.setAttribute('aria-selected', String(this.data.customers[i] && this.data.customers[i].key === key)));
    const aside = this.root.querySelector('aside');
    if (!aside) return;
    aside.replaceChildren(el('div', { class: 'adm-card' }, loadingBlock('Loading customer…')));
    let detail;
    try {
      detail = await A.customer(key);
    } catch (err) {
      aside.replaceChildren(el('div', { class: 'adm-card' }, errorBlock(err)));
      return;
    }
    if (this.key !== key) return;
    aside.replaceChildren(this.detailCard(detail));
    if (window.matchMedia('(max-width: 1180px)').matches) aside.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },

  detailCard({ customer: c, bookings: list, note }) {
    const noteBox = textareaEl({ name: 'note', maxlength: '5000', placeholder: 'Only you can see this' }, note);
    const noteForm = el('form', { class: 'adm-stack', novalidate: true }, field('Private notes', noteBox), formNotice(), el('div', {}, btn('Save note', null, { type: 'submit' })));
    noteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(noteForm.querySelector('[type="submit"]'), async () => { await A.saveNote(c.key, noteBox.value); toast('Note saved.'); }, (err) => showApiError(noteForm, err));
    });
    return el('div', { class: 'adm-card adm-detail' },
      el('div', {}, el('h2', { class: 'adm-card-title', text: c.name }),
        el('p', { class: 'adm-note', text: `${c.type === 'account' ? 'Account' : 'Guest'} · first seen ${fmt.short(c.firstSeen.slice(0, 10))} ${c.firstSeen.slice(0, 4)}` })),
      el('div', { class: 'adm-contact' },
        el('a', { class: 'btn btn-ghost btn-sm', href: `tel:${c.phoneE164}` }, 'Call'),
        el('a', { class: 'btn btn-ghost btn-sm', href: `sms:${c.phoneE164}` }, 'Text'),
        c.email ? el('a', { class: 'btn btn-ghost btn-sm', href: `mailto:${c.email}` }, 'Email') : null),
      el('div', { class: 'adm-stats3' },
        el('div', {}, el('strong', { text: String(c.bookings) }), el('span', { text: 'Bookings' })),
        el('div', {}, el('strong', { text: euro(c.spentEur) }), el('span', { text: 'Spent' })),
        el('div', {}, el('strong', { text: String(c.cancelled) }), el('span', { text: 'Cancelled' }))),
      el('dl', { class: 'facts' }, [['Email', c.email || '—'], ['Phone', c.phone], ['Vehicle', c.vehicle || '—'], ['Last valet', relDay(c.lastValet)]].map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v })))),
      el('div', { class: 'adm-stack' }, el('p', { class: 'panel-title', text: 'Bookings' }),
        list.length ? el('ul', { class: 'adm-list' }, list.map((b) => el('li', {},
          el('a', { class: 'adm-list-main', href: `#bookings?date=${b.date}&ref=${enc(b.reference)}`, style: { color: 'inherit' } },
            el('span', { class: 'adm-list-title', text: b.service.name }), el('span', { class: 'adm-list-sub', text: `${fmt.short(b.date)} ${b.date.slice(0, 4)} · ${b.reference}` })),
          pill(b.status)))) : el('p', { class: 'adm-note', text: 'No bookings.' })),
      noteForm,
      el('div', { class: 'adm-stack' },
        btn('Book for this customer', () => openBookingForm({
          name: c.name, phone: c.phone, email: c.email, vehicle: c.vehicle,
          customerUserId: c.userId, customerName: c.userId ? c.name : null,
        }, (b) => { location.hash = `bookings?date=${b.date}&ref=${enc(b.reference)}`; }), { kind: 'gold' }),
        c.type === 'account' ? btn('Send password reset link', (e) => busy(e.currentTarget, async () => {
          await A.resetLink(c.key);
          e.target.textContent = 'Reset link sent';
          toast(`Reset link sent to ${c.email}.`);
        })) : null,
        btn('Delete personal data (GDPR)', async (e) => {
          const button = e.currentTarget;
          if (!(await confirmDialog({
            title: `Delete ${c.name}'s details?`,
            text: 'Their name, phone, email, vehicle, addresses and notes are removed from every booking, and any account is deleted. Bookings stay in your records as "Deleted customer". This cannot be undone.',
            confirmLabel: 'Delete details', danger: true,
          }))) return;
          busy(button, async () => {
            const res = await A.eraseCustomer(c.key);
            toast(`Personal data deleted (${plural(res.erasedBookings, 'booking')} anonymised).`);
            this.key = null;
            await this.load();
          });
        }, { kind: 'text' })));
  },
};

// =====================================================================================
// Analytics
// =====================================================================================

const analytics = {
  range: 30,
  timer: null,
  async open(root, params, refresh = false) {
    this.root = root;
    this.range = [7, 30, 90].includes(Number(params.get('range'))) ? Number(params.get('range')) : this.range;
    root.replaceChildren(loadingBlock('Loading website statistics…'));
    let a;
    try {
      a = await A.analytics(this.range, refresh);
    } catch (err) {
      root.replaceChildren(head('h-analytics', 'Analytics'), errorBlock(err, () => this.open(root, params)));
      return;
    }
    if (!a.configured) {
      root.replaceChildren(head('h-analytics', 'Analytics'), card('Google Analytics is not connected yet', [
        el('p', { class: 'panel-copy', text: 'Once GA4_PROPERTY_ID and the Google service account are set on the server, visitor numbers, sources, devices and the booking funnel appear here.' }),
        el('p', { class: 'adm-note', text: `Meanwhile: ${plural(a.bookings, 'booking')} in the last ${a.rangeDays} days.` }),
      ]));
      return;
    }
    const t = a.totals;
    const p = a.previous;
    const days = a.rangeDays;
    const booked = a.bookings;
    const rate = t.visitors ? Math.round((booked / t.visitors) * 1000) / 10 : 0;
    const live = el('span', { class: 'pill pill-confirmed', 'aria-live': 'polite', text: `${plural(a.activeNow, 'person', 'people')} on the site now` });
    const f = a.funnel;
    const steps = [['Visited the website', f.visited], ['Opened the booking page', f.openedBookingPage], ['Picked a slot', f.pickedSlot], ['Booked', booked]];
    const funnel = el('ul', { class: 'adm-funnel' }, steps.map(([label, n], i) => {
      const prev = i ? steps[i - 1][1] : null;
      const pct = prev ? Math.round((n / prev) * 100) : null;
      return el('li', {},
        el('div', { class: 'adm-funnel-row' }, el('span', { text: label }), el('span', { text: `${n.toLocaleString('en-IE')}${pct !== null ? ` · ${pct}% of previous step` : ''}` })),
        el('span', { class: 'adm-share-track', 'aria-hidden': 'true' }, el('span', { class: 'adm-share-fill', style: { width: `${f.visited ? Math.min(100, (n / f.visited) * 100) : 0}%` } })));
    }));
    const townTotal = t.visitors || 1;
    root.replaceChildren(
      head('h-analytics', 'Analytics', `Google Analytics${a.measurementId ? ` · ${a.measurementId}` : ''} · updated ${relTime(a.fetchedAt)}`, [
        live,
        seg([[7, '7 days'], [30, '30 days'], [90, '90 days']], this.range, (r) => { location.hash = `analytics?range=${r}`; }, 'Date range'),
        btn('Refresh', () => this.open(root, params, true)),
        el('a', { class: 'btn btn-text btn-sm', href: 'https://analytics.google.com/analytics/web/', target: '_blank', rel: 'noopener' }, 'Open Google Analytics'),
      ]),
      el('div', { class: 'adm-tiles' },
        tile('Visitors', t.visitors.toLocaleString('en-IE'), { change: change(t.visitors, p.visitors, days) }),
        tile('Visits', t.sessions.toLocaleString('en-IE'), { change: change(t.sessions, p.sessions, days) }),
        tile('Page views', t.pageViews.toLocaleString('en-IE'), { change: change(t.pageViews, p.pageViews, days) }),
        tile('Avg. time on site', seconds(t.avgSessionSeconds), { sub: 'Per visit' }),
        tile('Visitors who booked', `${rate}%`, { sub: `${plural(booked, 'booking')} in ${days} days` })),
      card('Visitors per day', barChart(a.daily.map((d) => ({ label: fmt.short(d.date), value: d.visitors, tip: `${fmt.short(d.date)}: ${plural(d.visitors, 'visitor')} · ${plural(d.pageViews, 'page view')}` })), { caption: `${a.daily.length ? a.daily[a.daily.length - 1].visitors : 0} today`, valueLabel: 'Visitors' })),
      el('div', { class: 'adm-cols' },
        card('Where visitors come from', shareBars(a.sources.map((s) => ({ name: s.name, share: s.share, display: `${s.sessions} · ${s.share}%` })))),
        card('From visit to booking', [funnel, el('p', { class: 'adm-note', text: '"Booked" counts bookings made in the period; the other steps come from Google Analytics (visitors who allowed cookies).' })])),
      el('div', { class: 'adm-cols' },
        card('Devices', shareBars(a.devices.map((d) => ({ name: d.name, share: d.share })))),
        card('Top towns', shareBars(a.towns.map((x) => ({ name: x.name, share: Math.round((x.visitors / townTotal) * 100), display: `${Math.round((x.visitors / townTotal) * 100)}%` }))))),
      card('Most viewed pages', a.pages.length ? el('div', { class: 'adm-table-wrap' }, el('table', { class: 'adm-table' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Page' }), el('th', { class: 'num', text: 'Views' }), el('th', { class: 'num', text: 'Avg. time on page' }))),
        el('tbody', {}, a.pages.map((pg) => el('tr', {},
          el('td', {}, el('span', { class: 'adm-cell-main' }, el('span', { text: pg.title || pg.path }), el('span', { class: 'adm-cell-sub', text: pg.path }))),
          el('td', { class: 'num', text: pg.views.toLocaleString('en-IE') }),
          el('td', { class: 'num', text: seconds(pg.avgSecondsPerView) })))))) : empty('No page views yet.')));

    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await A.live();
        live.textContent = `${plural(r.activeNow, 'person', 'people')} on the site now`;
      } catch { /* keep the last figure */ }
    }, 60_000);
  },
  leave() { clearInterval(this.timer); },
};

// =====================================================================================
// Settings
// =====================================================================================

const settings = {
  async open(root) {
    this.root = root;
    root.replaceChildren(loadingBlock('Loading settings…'));
    try {
      const [s, integ, team] = await Promise.all([A.settings(), A.integrations(), A.team()]);
      this.d = draft(s.settings);
      this.integ = integ;
      this.teamData = team;
    } catch (err) {
      root.replaceChildren(errorBlock(err, () => this.open(root)));
      return;
    }
    this.render();
  },
  get dirty() { return Boolean(this.d && this.d.dirty); },

  render() {
    const v = this.d.value;
    const form = el('form', { class: 'adm-form', novalidate: true });
    const bar = saveBar(this.d, { onSave: (b) => this.save(b, form), onDiscard: () => { this.d.discard(); this.render(); } });
    bar.el.querySelector('.btn-gold').firstChild.textContent = 'Save settings';
    form.addEventListener('input', (e) => { if (e.target.matches('input, textarea, select')) clearFieldError(e.target); bar.refresh(); });
    const text = (section, key, attrs = {}, map = (x) => x) => {
      const i = inputEl({ name: `${section}.${key}`, ...attrs }, v[section][key]);
      i.addEventListener('input', () => { v[section][key] = map(i.value); });
      return i;
    };
    const number = (section, key, attrs) => text(section, key, { type: 'number', step: '1', ...attrs }, (x) => (x === '' ? 0 : Number(x)));
    const optional = (x) => (x.trim() ? x : null);
    const pairBox = (obj, key, label) => {
      const box = el('input', { type: 'checkbox', 'aria-label': label });
      box.checked = obj[key];
      box.addEventListener('change', () => { obj[key] = box.checked; bar.refresh(); });
      return box;
    };

    const pausedMsg = field('Message on the booking page', textareaEl({ name: 'booking.pausedMessage', maxlength: '300', placeholder: 'e.g. Back from holidays on Monday 3 November!' }, v.booking.pausedMessage));
    pausedMsg.querySelector('textarea').addEventListener('input', (e) => { v.booking.pausedMessage = optional(e.target.value); });
    pausedMsg.hidden = !v.booking.paused;

    const hours = v.business.openingHours.map((row, i) => el('div', { class: 'adm-fields' },
      field('Days', (() => { const x = inputEl({ name: `business.openingHours.${i}.label`, maxlength: '40', placeholder: 'Monday – Friday' }, row.label); x.addEventListener('input', () => { row.label = x.value; }); return x; })()),
      field('Hours', (() => { const x = inputEl({ name: `business.openingHours.${i}.hours`, maxlength: '40', placeholder: '9:00 – 17:30' }, row.hours); x.addEventListener('input', () => { row.hours = x.value; }); return x; })()),
      el('div', { style: { alignSelf: 'center' } }, btn('Remove', () => { v.business.openingHours.splice(i, 1); this.render(); }, { kind: 'text' }))));

    form.append(
      card('Online booking', [
        switchEl('Pause online booking', v.booking.paused, (on) => { v.booking.paused = on; pausedMsg.hidden = !on; bar.refresh(); }),
        el('p', { class: 'adm-note', text: 'While paused, the booking page shows your message and customers are asked to call. You can still add bookings here.' }),
        pausedMsg,
      ]),
      card('Business details', [
        el('div', { class: 'adm-fields' },
          field('Business name', text('business', 'name', { maxlength: '80' })),
          field('Phone', text('business', 'phone', { type: 'tel', maxlength: '30' })),
          field('Public email', text('business', 'publicEmail', { type: 'email', maxlength: '254' }, optional))),
        field('Address', text('business', 'address', { maxlength: '200' })),
        el('p', { class: 'panel-title', text: 'Opening hours' }),
        hours.length ? el('div', { class: 'adm-items' }, hours) : el('p', { class: 'adm-note', text: 'Not shown on the website until you add them.' }),
        v.business.openingHours.length < 7 ? el('div', {}, btn('Add a row', () => { v.business.openingHours.push({ label: '', hours: '' }); this.render(); })) : null,
      ]),
      card('Booking rules', [
        el('div', { class: 'adm-fields' },
          field('How far ahead customers can book (weeks)', number('booking', 'maxWeeksAhead', { min: '1', max: '52' })),
          field('Minimum notice (hours)', number('booking', 'minNoticeHours', { min: '0', max: '168' })),
          field('Online cancellation until (hours before)', number('booking', 'cancelCutoffHours', { min: '0', max: '720' }))),
        switchEl('Confirm bookings automatically', v.booking.autoConfirm, (on) => { v.booking.autoConfirm = on; bar.refresh(); }),
      ]),
      card('Alerts to you', [
        el('div', { class: 'adm-fields' },
          field('Your email', text('alerts', 'ownerEmail', { type: 'email', maxlength: '254' }, optional)),
          field('Your mobile', text('alerts', 'ownerPhone', { type: 'tel', maxlength: '30' }, optional))),
        el('table', { class: 'adm-matrix' },
          el('thead', {}, el('tr', {}, el('th', { text: 'When' }), el('th', { text: 'Email' }), el('th', { text: 'Text' }))),
          el('tbody', {},
            el('tr', {}, el('td', { text: 'New booking' }), el('td', {}, pairBox(v.alerts.newBooking, 'email', 'New booking by email')), el('td', {}, pairBox(v.alerts.newBooking, 'sms', 'New booking by text'))),
            el('tr', {}, el('td', { text: 'Customer cancels' }), el('td', {}, pairBox(v.alerts.customerCancels, 'email', 'Cancellation by email')), el('td', {}, pairBox(v.alerts.customerCancels, 'sms', 'Cancellation by text'))),
            el('tr', {}, el('td', { text: 'Daily summary at 8am' }), el('td', {}, pairBox(v.alerts, 'dailySummary', 'Daily summary by email')), el('td', { class: 'muted', text: '—' })))),
      ]),
      card('Messages to customers', [
        el('ul', { class: 'adm-list' },
          el('li', {}, el('span', { class: 'adm-list-title', text: 'Booking received and booking confirmed' }), el('span', { class: 'adm-note', text: 'Always sent' })),
          el('li', {}, switchEl('Reminder the evening before (6pm, text and email)', v.messages.reminder, (on) => { v.messages.reminder = on; bar.refresh(); })),
          el('li', {}, switchEl('Ask for a Google review (email the day after a completed valet)', v.messages.reviewRequest, (on) => { v.messages.reviewRequest = on; bar.refresh(); }))),
        field('Google review link (for review requests)', text('messages', 'googleReviewUrl', { type: 'url', maxlength: '500', placeholder: 'https://g.page/r/…' }, optional)),
      ]),
      formNotice());

    this.root.replaceChildren(
      head('h-settings', 'Settings', 'Booking rules, alerts and messages take effect as soon as you save.'),
      form,
      this.servicesCard(),
      this.teamCard(),
      bar.el);
  },

  save(button, form) {
    setFormError(form, '');
    busy(button, async () => {
      const res = await A.saveSettings(this.d.value);
      this.d.reset(res.settings);
      toast('Settings saved.');
      this.render();
    }, (err) => showApiError(form, err));
  },

  servicesCard() {
    const i = this.integ;
    const status = (on, onText = 'Connected') => el('span', { class: `pill ${on ? 'pill-confirmed' : 'pill-cancelled'}`, text: on ? onText : 'Not set up' });
    const row = (name, detail, on, action) => el('li', {},
      el('div', { class: 'adm-list-main' }, el('span', { class: 'adm-list-title', text: name }), el('span', { class: 'adm-list-sub', text: detail })),
      el('div', { class: 'adm-actions' }, status(on), action || null));
    const feed = i.iphoneCalendar.feedUrl;
    return card('Connected services', [
      el('ul', { class: 'adm-list' },
        row('Email · Resend', i.email.configured ? `Sends from ${i.email.from}` : 'Add RESEND_API_KEY on the server', i.email.configured,
          btn('Send test', (e) => busy(e.currentTarget, async () => { const r = await A.testEmail(); toast(`Test email sent to ${r.to}.`); }))),
        row('Text messages · Sendmode', i.sms.configured ? `Sender name: ${i.sms.senderId}` : 'Add SENDMODE_ACCESS_KEY on the server', i.sms.configured,
          btn('Send test', (e) => busy(e.currentTarget, async () => { const r = await A.testSms(); toast(`Test text sent to ${r.to}.`); }))),
        row('Google Calendar', i.calendar.configured ? 'Bookings appear in your Google Calendar' : 'Add the Google service account and calendar ID on the server', i.calendar.configured,
          i.calendar.configured ? btn('Sync now', (e) => busy(e.currentTarget, async () => { const r = await A.syncCalendar(); toast(`${plural(r.queued, 'booking')} sent to Google Calendar.`); })) : null),
        row('Google Analytics', i.analytics.measurementId ? `Measurement ID ${i.analytics.measurementId}` : 'Add GA4_MEASUREMENT_ID and GA4_PROPERTY_ID on the server', i.analytics.configured,
          el('a', { class: 'btn btn-text btn-sm', href: '#analytics' }, 'Open')),
        row('Online deposits · Stripe', i.payments.configured ? 'Customers can pay the deposit online' : 'Deposits are requested by message instead', i.payments.configured),
        row('iPhone calendar', feed ? 'Subscribed calendar of all bookings' : 'Set ADMIN_CALENDAR_FEED_KEY on the server', Boolean(feed), feed ? btn('Copy link', () => copyText(feed)) : null)),
    ]);
  },

  teamCard() {
    const t = this.teamData;
    const update = (team) => { this.teamData = { members: team.members, invites: team.invites }; this.root.querySelector('[data-team]').replaceWith(this.teamCard()); };
    const form = el('form', { class: 'adm-inline-form', novalidate: true });
    const email = inputEl({ name: 'email', type: 'email', maxlength: '254', placeholder: 'name@example.com', autocomplete: 'off' });
    const access = selectEl({ name: 'access' }, [['bookings', 'Bookings only'], ['full', 'Full access']], 'bookings');
    form.append(field('Invite by email', email), field('Access', access), btn('Send invite', null, { kind: 'gold', type: 'submit' }), formNotice());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      setFormError(form, '');
      busy(form.querySelector('[type="submit"]'), async () => {
        const res = await A.invite({ email: email.value.trim(), access: access.value });
        toast(`Invite sent to ${email.value.trim()}.`);
        update(res);
      }, (err) => showApiError(form, err));
    });
    const accessLabel = (a) => (a === 'full' ? 'Full access' : 'Bookings only');
    return el('section', { class: 'adm-card', 'data-team': '' },
      el('div', { class: 'adm-card-head' }, el('h2', { class: 'adm-card-title', text: 'Team access' })),
      el('ul', { class: 'adm-list' }, t.members.map((m) => el('li', {},
        el('div', { class: 'adm-list-main' }, el('span', { class: 'adm-list-title', text: `${m.name}${m.isYou ? ' (you)' : ''}` }), el('span', { class: 'adm-list-sub', text: `${m.email} · ${accessLabel(m.access)}` })),
        m.isYou ? null : btn('Remove', async (e) => {
          const button = e.currentTarget;
          if (!(await confirmDialog({ title: `Remove ${m.name}?`, text: 'They lose access to the dashboard and are signed out. Their customer account stays.', confirmLabel: 'Remove', danger: true }))) return;
          busy(button, async () => { update(await A.removeMember(m.id)); toast(`${m.name} removed.`); });
        }, { kind: 'text' })))),
      t.invites.length ? el('div', { class: 'adm-stack' }, el('p', { class: 'panel-title', text: 'Invites waiting' }),
        el('ul', { class: 'adm-list' }, t.invites.map((inv) => el('li', {},
          el('div', { class: 'adm-list-main' }, el('span', { class: 'adm-list-title', text: inv.email }), el('span', { class: 'adm-list-sub', text: `${accessLabel(inv.access)} · expires ${fmt.dateTime(inv.expiresAt)}` })),
          btn('Revoke', (e) => busy(e.currentTarget, async () => { update(await A.revokeInvite(inv.id)); toast('Invite revoked.'); }), { kind: 'text' }))))) : null,
      form,
      el('p', { class: 'adm-note', text: 'Invites are emailed and work for 7 days. "Bookings only" can manage bookings and slots, nothing else.' }));
  },
};

// =====================================================================================
// Router and start-up
// =====================================================================================

const SCREENS = { overview, bookings, prices, discounts, photos, customers, analytics, settings };
const TITLES = { overview: 'Overview', bookings: 'Bookings', prices: 'Services & prices', discounts: 'Discounts', photos: 'Photos', customers: 'Customers', analytics: 'Analytics', settings: 'Settings' };
let me = null;
let isAdmin = false;
let current = null;
let currentHash = '';
let ignoreHash = false;

function parseHash() {
  const [name, query] = location.hash.replace(/^#/, '').split('?');
  return { name, params: new URLSearchParams(query || '') };
}

async function route({ focus = true } = {}) {
  let { name, params } = parseHash();
  if (!SCREENS[name]) name = isAdmin ? 'overview' : 'bookings';
  if (!isAdmin && name !== 'bookings') name = 'bookings';
  if (current && current !== name && SCREENS[current].leave) SCREENS[current].leave();
  current = name;
  currentHash = location.hash;
  document.querySelectorAll('[data-screen]').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  document.querySelectorAll('[data-nav-item]').forEach((a) => {
    if (a.dataset.navItem === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[name]} · Dashboard · St Johns Park`;
  closeMenu();
  const root = $(`[data-screen="${name}"]`);
  await SCREENS[name].open(root, params);
  if (focus) {
    const h = root.querySelector('.adm-title');
    if (h) h.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', async () => {
  if (ignoreHash) { ignoreHash = false; return; }
  const screen = current && SCREENS[current];
  const leavingScreen = parseHash().name !== current;
  if (screen && screen.dirty && leavingScreen) {
    const target = location.hash;
    ignoreHash = true;
    history.replaceState(null, '', currentHash || '#');
    ignoreHash = false;
    if (!(await confirmDialog({ title: 'Leave without saving?', text: 'Your changes on this page will be lost.', confirmLabel: 'Leave', cancelLabel: 'Stay', danger: true }))) return;
    history.replaceState(null, '', target);
  }
  route();
});
window.addEventListener('beforeunload', (e) => {
  const screen = current && SCREENS[current];
  if (screen && screen.dirty) e.preventDefault();
});

const nav = $('[data-nav]');
const menuBtn = $('[data-menu]');
function closeMenu() {
  nav.classList.remove('is-open');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', () => {
  const open = !nav.classList.contains('is-open');
  nav.classList.toggle('is-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
});

$('[data-sign-out]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  await api.logout();
  location.replace('account.html');
}));

async function init() {
  const user = await currentUser();
  if (!user) {
    location.replace(SIGN_IN);
    return;
  }
  $('[data-loading]').hidden = true;
  if (user.role !== 'admin' && user.role !== 'staff') {
    $('[data-denied-text]').textContent = `You're signed in as ${user.username}. This page is for the St Johns Park team.`;
    $('[data-denied]').hidden = false;
    nav.hidden = true;
    return;
  }
  me = user;
  isAdmin = user.role === 'admin';
  const words = (user.fullName || user.username).trim().split(/\s+/);
  $('[data-initials]').textContent = ((words[0] || '').charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : '')).toUpperCase();
  $('[data-user-name]').textContent = user.fullName || user.username;
  $('[data-user-role]').textContent = isAdmin ? 'Owner · full access' : 'Bookings only';
  $('[data-user-chip]').hidden = false;
  if (!isAdmin) {
    document.querySelectorAll('[data-nav-item]').forEach((a) => { a.hidden = a.dataset.navItem !== 'bookings'; });
  }
  await route({ focus: false });
  refreshBadges();
  setInterval(() => { if (!document.hidden) refreshBadges(); }, 60_000);
}

init();
