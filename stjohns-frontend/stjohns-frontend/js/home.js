import { api } from './api.js';
import { addDays, el, fmt, isoDate } from './ui.js';

// ---------- Hero slideshow ----------
const SLIDE_MS = 5000;
const hero = document.querySelector('.hero');
const slides = [...document.querySelectorAll('.hero-slide')];
const dotsWrap = document.querySelector('[data-dots]');
const numEl = document.querySelector('[data-slide-num]');
const labelEl = document.querySelector('[data-slide-label]');
const pauseBtn = document.querySelector('[data-pause]');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
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

const dots = slides.map((slide, i) => {
  const dot = el('button', { class: 'hero-dot', type: 'button', 'aria-label': `Show slide ${i + 1}: ${slide.dataset.label}` }, el('span'));
  dot.addEventListener('click', () => { show(i); schedule(); });
  dotsWrap.append(dot);
  return dot;
});

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
  labelEl.textContent = slides[current].dataset.label;
}

function schedule() {
  clearTimeout(timer);
  hero.classList.toggle('is-paused', paused);
  pauseBtn.setAttribute('aria-pressed', String(paused));
  pauseBtn.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
  if (!paused && !document.hidden) timer = setTimeout(() => { show(current + 1); schedule(); }, SLIDE_MS);
}

if (hero && slides.length) {
  hero.style.setProperty('--slide-ms', `${SLIDE_MS}ms`);
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

// ---------- Live data: prices, slot times, next free slot ----------
async function enhance() {
  try {
    const config = await api.config();
    for (const service of config.services) {
      const card = document.querySelector(`.service[data-service="${service.code}"]`);
      const price = card && card.querySelector('[data-price]');
      if (price && service.priceEur !== null && service.priceEur !== undefined) {
        price.querySelector('[data-price-value]').textContent = `€${service.priceEur}`;
        price.hidden = false;
      }
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
    // The page works without live data; prices and the next slot simply stay hidden.
  }
}
enhance();
