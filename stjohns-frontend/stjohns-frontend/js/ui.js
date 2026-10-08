// Shared page behaviour: mobile menu, signed-in state in the header, toasts, safe DOM building and date formatting.
import { api } from './api.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' → local Date at midnight (no time-zone shift). */
export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
/** Monday of the week containing the date. */
export function mondayOf(iso) {
  const d = parseDate(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}
export const fmt = {
  long: (iso) => { const d = parseDate(iso); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; },
  short: (iso) => { const d = parseDate(iso); return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; },
  dow: (iso) => WEEKDAYS[parseDate(iso).getDay()].slice(0, 3),
  monthShort: (iso) => MONTHS[parseDate(iso).getMonth()].slice(0, 3),
  monthYear: (iso) => { const d = parseDate(iso); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; },
  dateTime: (isoString) => {
    const d = new Date(isoString);
    return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },
};

/**
 * Tiny DOM builder. Text is always set with textContent, so API data can never inject HTML.
 * el('a', { class: 'btn', href: '#' }, 'Label', childNode)
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Inline SVG icon from path data (stroke icons, 24×24). */
export function icon(paths, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
export const ICONS = {
  check: 'M4 12l5 5L20 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  calendar: ['M4 6h16v14H4z', 'M4 10h16M8 4v4M16 4v4'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.5-4.5'],
};

let toastRegion;
export function toast(message, { error = false, timeout = 5000 } = {}) {
  if (!toastRegion) {
    toastRegion = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const t = el('div', { class: `toast${error ? ' toast-error' : ''}` }, message);
  toastRegion.append(t);
  setTimeout(() => t.remove(), timeout);
}

/** Show field-level errors from an ApiError (or a plain object) on a form. */
export function showFieldErrors(form, fields = {}) {
  form.querySelectorAll('.field').forEach((f) => {
    f.classList.remove('invalid');
    const e = f.querySelector('.error');
    if (e) e.textContent = '';
  });
  let first = null;
  for (const [name, message] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${name}"]`);
    const field = input && input.closest('.field');
    if (!field) continue;
    field.classList.add('invalid');
    const e = field.querySelector('.error');
    if (e) e.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    first = first || input;
  }
  if (first) first.focus();
  return Boolean(first);
}
export function clearFieldError(input) {
  const field = input.closest('.field');
  if (!field) return;
  field.classList.remove('invalid');
  input.removeAttribute('aria-invalid');
  const e = field.querySelector('.error');
  if (e) e.textContent = '';
}

export function param(name) {
  return new URLSearchParams(location.search).get(name);
}

/** Resolves to the signed-in user or null; never throws. Shared by every page. */
let mePromise;
export function currentUser() {
  mePromise = mePromise || api.me().then((r) => r.user).catch(() => null);
  return mePromise;
}

function initHeader() {
  const toggle = document.querySelector('.nav-toggle');
  const menu = document.getElementById('mobile-nav');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      menu.hidden = open;
    });
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a')) { toggle.setAttribute('aria-expanded', 'false'); menu.hidden = true; }
    });
  }
  // Swap "Sign in" for "My bookings" once we know the visitor is signed in.
  const accountLinks = document.querySelectorAll('[data-account-link]');
  if (accountLinks.length) {
    currentUser().then((user) => {
      if (!user) return;
      accountLinks.forEach((a) => {
        a.href = 'my-bookings.html';
        const label = a.querySelector('[data-account-label]') || a;
        label.textContent = 'My bookings';
      });
    });
  }
  document.querySelectorAll('[data-year]').forEach((n) => { n.textContent = String(new Date().getFullYear()); });
}

initHeader();
