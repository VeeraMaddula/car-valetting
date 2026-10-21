import { api } from './api.js';
import { addDays, el, fmt, isoDate } from './ui.js';

// ---------- Hero slideshow ----------
const hero = document.querySelector('.hero');
const slidesWrap = document.querySelector('.hero-slides');
const dotsWrap = document.querySelector('[data-dots]');
const numEl = document.querySelector('[data-slide-num]');
const totalEl = document.querySelector('[data-slide-total]');
const labelEl = document.querySelector('[data-slide-label]');
const pauseBtn = document.querySelector('[data-pause]');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let slideMs = 5000;
let slides = [...document.querySelectorAll('.hero-slide')];
let dots = [];
let current = 0;
let timer = null;
let paused = reduceMotion.matches;

function load(i) {
  const img = slides[i];
  if (img && img.dataset.srcset && !img.srcset) {
    img.sizes = '100vw';
    img.srcset = img.dataset.srcset;
    img.src = img.dataset.srcset.split(' ')[0];
  }
}

function buildDots() {
  dots = slides.map((slide, i) => {
    const label = slide.dataset.label;
    const dot = el('button', { class: 'hero-dot', type: 'button', 'aria-label': `Show slide ${i + 1}${label ? `: ${label}` : ''}` }, el('span'));
    dot.addEventListener('click', () => { show(i); schedule(); });
    return dot;
  });
  dotsWrap.replaceChildren(...dots);
  if (totalEl) totalEl.textContent = `/ ${String(slides.length).padStart(2, '0')}`;
  hero.style.setProperty('--slide-ms', `${slideMs}ms`);
}

function show(i) {
  current = (i + slides.length) % slides.length;
  load(current);
  load((current + 1) % slides.length);
  slides.forEach((s, j) => {
    const on = j === current;
    s.classList.toggle('is-active', on);
    s.alt = on ? (s.dataset.alt || s.alt) : '';
  });
  dots.forEach((d, j) => {
    // Re-adding the attribute restarts the progress animation.
    d.removeAttribute('aria-current');
    if (j === current) { void d.offsetWidth; d.setAttribute('aria-current', 'true'); }
  });
  numEl.textContent = String(current + 1).padStart(2, '0');
  labelEl.textContent = slides[current].dataset.label || '';
}

function schedule() {
  clearTimeout(timer);
  hero.classList.toggle('is-paused', paused);
  pauseBtn.setAttribute('aria-pressed', String(paused));
  pauseBtn.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
  if (!paused && !document.hidden) timer = setTimeout(() => { show(current + 1); schedule(); }, slideMs);
}

if (hero && slides.length) {
  buildDots();
  document.querySelector('[data-prev]').addEventListener('click', () => { show(current - 1); schedule(); });
  document.querySelector('[data-next]').addEventListener('click', () => { show(current + 1); schedule(); });
  pauseBtn.addEventListener('click', () => { paused = !paused; schedule(); });
  document.addEventListener('visibilitychange', schedule);
  reduceMotion.addEventListener('change', (e) => { if (e.matches) { paused = true; schedule(); } });
  show(0);
  schedule();
}

// ---------- Before / after ----------
const compare = document.querySelector('[data-compare]');
if (compare) {
  const range = compare.querySelector('input[type="range"]');
  const update = () => {
    compare.style.setProperty('--pos', `${range.value}%`);
    range.setAttribute('aria-valuetext', `${range.value}% showing before`);
  };
  range.addEventListener('input', update);
  update();
}

// ---------- Photos from the dashboard (slideshow, before & after, gallery tiles) ----------
// Anything the owner hasn't set up keeps the built-in photos.
const CATEGORY_LABELS = { exterior: 'Exterior', interior: 'Interior', wheels: 'Wheels', detail: 'Detail' };

function useSlides({ slides: list, seconds }) {
  const imgs = list.map((s) => el('img', { class: 'hero-slide', alt: '', 'data-alt': s.alt || '', 'data-label': s.caption || '', 'data-srcset': s.image.srcset }));
  const first = imgs[0];
  // Swap only once the first photo has arrived, so the hero never flashes empty.
  first.addEventListener('load', () => {
    clearTimeout(timer);
    slidesWrap.replaceChildren(...imgs);
    slides = imgs;
    slideMs = Math.min(10, Math.max(3, Number(seconds) || 5)) * 1000;
    buildDots();
    show(0);
    schedule();
  }, { once: true });
  first.sizes = '100vw';
  first.srcset = list[0].image.srcset;
  first.src = list[0].image.src;
}

function useCompare({ title, before, after }) {
  if (!compare) return;
  const set = (img, image, alt) => {
    img.srcset = image.srcset;
    img.src = image.src;
    img.alt = alt;
  };
  set(compare.querySelector('img:not(.compare-before)'), after, `After: ${title}`);
  set(compare.querySelector('.compare-before'), before, `Before: ${title}`);
  compare.classList.add('is-real');
  const lead = document.querySelector('[data-compare-lead]');
  if (lead) lead.textContent = `${title}. Slide across to compare before and after.`;
}

/** Starred photos first, then the rest, into the existing tiles (fewer photos than tiles keeps the built-in ones). */
function useTiles(photos) {
  const tiles = [...document.querySelectorAll('#gallery .tile')];
  const picks = [...photos.filter((p) => p.featured), ...photos.filter((p) => !p.featured)].slice(0, tiles.length);
  picks.forEach((p, i) => {
    const tile = tiles[i];
    const img = tile.querySelector('img');
    const label = CATEGORY_LABELS[p.category] || '';
    img.className = ''; // drop the built-in close-up crops
    img.sizes = tile.classList.contains('tile-tall') ? '(max-width: 760px) 100vw, 50vw' : '(max-width: 760px) 100vw, 25vw';
    img.srcset = p.image.srcset;
    img.src = p.image.src;
    img.alt = p.caption || `${label} valeting photo`;
    tile.href = `gallery.html#${p.category}`;
    tile.querySelector('.tile-cap').replaceChildren(el('span', { text: p.caption || label }), label && p.caption ? el('span', { class: 'label', text: label }) : null);
  });
}

async function useGallery() {
  let gallery;
  try {
    gallery = await api.gallery();
  } catch {
    return;
  }
  if (hero && gallery.slideshow && gallery.slideshow.slides.length) useSlides(gallery.slideshow);
  if (gallery.beforeAfter) useCompare(gallery.beforeAfter);
  if (gallery.photos && gallery.photos.length) useTiles(gallery.photos);
}
useGallery();

// ---------- Live data: services & prices, slot times, next free slot ----------
const euro = (amount) => `€${Number.isInteger(amount) ? amount : Number(amount).toFixed(2)}`;
const COUNT_WORDS = ['', 'One way', 'Two ways', 'Three ways', 'Four ways', 'Five ways', 'Six ways', 'Seven ways', 'Eight ways'];

/** One card per service offered in the dashboard (the built-in cards stay for visitors without JavaScript). */
function serviceCard(service, i, bySize) {
  const onSale = service.salePriceEur !== null && service.salePriceEur !== undefined;
  const hasPrice = service.priceEur !== null && service.priceEur !== undefined;
  const value = onSale
    ? [el('s', { class: 'price-was' }, el('span', { class: 'sr-only', text: 'was ' }), euro(service.priceEur)), el('span', { class: 'sr-only', text: 'now ' }), euro(service.salePriceEur)]
    : hasPrice ? [euro(service.priceEur)] : [];
  return el('article', { class: `card card-hover service${service.featured ? ' card-featured' : ''}`, 'data-service': service.code },
    service.featured ? el('span', { class: 'badge service-badge', text: 'Signature' }) : null,
    el('div', { class: 'service-top' },
      el('span', { class: 'service-num', text: String(i + 1).padStart(2, '0') }),
      service.durationLabel ? el('span', { class: 'label', text: service.durationLabel }) : null),
    el('h3', { class: 'h3', text: service.name }),
    service.description ? el('p', { class: 'service-desc', text: service.description }) : null,
    el('div', { class: 'service-foot' },
      hasPrice ? el('p', { class: 'service-price' },
        el('span', { class: 'label', text: `${service.priceFrom || bySize ? 'From' : 'Price'}${onSale ? ' · Sale' : ''}` }),
        el('span', { class: 'price' }, value)) : null,
      el('a', { class: `btn ${service.featured ? 'btn-gold' : 'btn-ghost'} btn-sm`, href: `booking.html?service=${encodeURIComponent(service.code)}` }, 'Book')));
}

async function enhance() {
  try {
    const config = await api.config();
    const bySize = Boolean(config.booking && config.booking.pricesBySize);
    const grid = document.querySelector('[data-services]');
    if (grid && config.services.length) {
      grid.replaceChildren(...config.services.map((s, i) => serviceCard(s, i, bySize)));
      const lead = document.querySelector('[data-services-lead]');
      const words = COUNT_WORDS[config.services.length];
      if (lead && words) lead.textContent = `${words} to bring your car back to its best — every one finished by hand and inspected under light before handover.`;
    }
    for (const period of config.periods) {
      const time = document.querySelector(`[data-slot-list] [data-period="${period.code}"] [data-time]`);
      if (time && period.startTime && period.endTime) time.textContent = `${period.startTime}–${period.endTime}`;
    }
    const today = isoDate(new Date());
    const availability = await api.availability(today, addDays(today, 20));
    for (const day of availability.days) {
      const slot = day.slots.find((s) => s.status === 'available');
      if (slot) {
        const next = document.querySelector('[data-next-free]');
        next.textContent = `Next free slot: ${day.isToday ? 'today' : fmt.long(day.date)} · ${slot.label}`;
        next.hidden = false;
        break;
      }
    }
  } catch {
    // The page works without live data; the built-in cards and the next slot simply stay as they are.
  }
}
enhance();
