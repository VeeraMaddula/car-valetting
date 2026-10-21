// Gallery page: category filters and a photo lightbox built on the native <dialog>.
// Tiles are plain links to the full-size photo, so the page still works if this script fails to load.
// Photos uploaded in the dashboard (GET /gallery) replace the built-in ones once they arrive.
import { api } from './api.js';
import { el } from './ui.js';

const grid = document.querySelector('[data-grid]');
let items = [...grid.querySelectorAll('.g-item')];
const chips = [...document.querySelectorAll('[data-filter]')];
const status = document.querySelector('[data-status]');
const filters = new Set(chips.map((chip) => chip.dataset.filter));

// ---------- Filters ----------
const matches = (item, filter) => filter === 'all' || item.dataset.category === filter;
const visibleItems = () => items.filter((item) => !item.hidden);

/** Count per chip; categories with no photos hide their chip. */
function recount() {
  chips.forEach((chip) => {
    const n = items.filter((item) => matches(item, chip.dataset.filter)).length;
    const count = chip.querySelector('[data-count]');
    if (count) count.textContent = String(n);
    chip.hidden = chip.dataset.filter !== 'all' && n === 0;
  });
}
recount();

function applyFilter(filter, { updateUrl = true } = {}) {
  if (!filters.has(filter)) filter = 'all';
  chips.forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter)));
  let shown = 0;
  for (const item of items) {
    const show = matches(item, filter);
    if (show && item.hidden) {
      // Restart the fade-in for tiles coming back into view.
      item.classList.remove('is-entering');
      void item.offsetWidth;
      item.classList.add('is-entering');
    }
    item.hidden = !show;
    if (show) shown += 1;
  }
  const noun = shown === 1 ? 'photo' : 'photos';
  const label = chips.find((chip) => chip.dataset.filter === filter).dataset.label || filter;
  status.textContent = filter === 'all' ? `Showing all ${shown} ${noun}` : `Showing ${shown} ${label} ${noun}`;
  if (updateUrl) history.replaceState(null, '', filter === 'all' ? location.pathname + location.search : `#${filter}`);
}

chips.forEach((chip) => chip.addEventListener('click', () => applyFilter(chip.dataset.filter)));
grid.addEventListener('animationend', (e) => e.target.classList.remove('is-entering'));

// gallery.html#wheels opens with that filter selected.
const fromHash = () => location.hash.slice(1).toLowerCase();
if (filters.has(fromHash())) applyFilter(fromHash(), { updateUrl: false });
window.addEventListener('hashchange', () => { if (filters.has(fromHash())) applyFilter(fromHash(), { updateUrl: false }); });

// ---------- Lightbox ----------
const dialog = document.querySelector('[data-lightbox]');
const frame = dialog.querySelector('[data-lb-frame]');
const photo = dialog.querySelector('[data-lb-img]');
const title = dialog.querySelector('[data-lb-title]');
const category = dialog.querySelector('[data-lb-cat]');
const counter = dialog.querySelector('[data-lb-count]');
const position = dialog.querySelector('[data-lb-position]');
const prevBtn = dialog.querySelector('[data-lb-prev]');
const nextBtn = dialog.querySelector('[data-lb-next]');
let currentItem = null;
const preloaded = new Set();

const linkOf = (item) => item.querySelector('.g-link');
const fullSrc = (item) => linkOf(item).getAttribute('href');

function preload(item) {
  const src = fullSrc(item);
  if (preloaded.has(src)) return;
  preloaded.add(src);
  new Image().src = src;
}

function markReady() {
  frame.classList.remove('lb-loading');
  photo.classList.add('is-ready');
}
photo.addEventListener('load', markReady);
photo.addEventListener('error', markReady);

function show(item) {
  const list = visibleItems();
  const index = list.indexOf(item);
  const thumb = linkOf(item).querySelector('img');
  currentItem = item;

  // Carry the tile's detail crop (if any) over to the large photo.
  const crop = [...thumb.classList].filter((c) => c === 'crop' || c.startsWith('crop-'));
  photo.className = ['lb-img', ...crop].join(' ');
  frame.classList.add('lb-loading');
  photo.alt = thumb.alt;
  photo.src = fullSrc(item);
  if (photo.complete && photo.naturalWidth) markReady();

  title.textContent = item.querySelector('.g-cap-title').textContent;
  category.textContent = item.querySelector('.g-cap .label').textContent;
  counter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(list.length).padStart(2, '0')}`;
  position.textContent = `Photo ${index + 1} of ${list.length}`;

  const several = list.length > 1;
  prevBtn.hidden = !several;
  nextBtn.hidden = !several;
  if (several) {
    preload(list[(index + 1) % list.length]);
    preload(list[(index - 1 + list.length) % list.length]);
  }
}

function step(delta) {
  const list = visibleItems();
  if (list.length < 2 || !currentItem) return;
  const index = list.indexOf(currentItem);
  show(list[(index + delta + list.length) % list.length]);
}

function open(item) {
  show(item);
  document.documentElement.classList.add('lb-open');
  dialog.showModal();
  if (window.sjpTrack) window.sjpTrack('view_gallery_photo', { photo_title: title.textContent });
}

grid.addEventListener('click', (e) => {
  const link = e.target.closest('.g-link');
  // Leave modified clicks (new tab, download) and browsers without <dialog> to the plain link.
  if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (typeof dialog.showModal !== 'function') return;
  e.preventDefault();
  open(link.closest('.g-item'));
});

dialog.querySelector('[data-lb-close]').addEventListener('click', () => dialog.close());
prevBtn.addEventListener('click', () => step(-1));
nextBtn.addEventListener('click', () => step(1));

// Clicking the dark area around the photo closes the viewer; Esc is handled natively by <dialog>.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog || e.target.hasAttribute('data-lb-dismiss')) dialog.close();
});

dialog.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
});

// Swipe left/right on touch screens.
let touchStartX = null;
frame.addEventListener('touchstart', (e) => { touchStartX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
frame.addEventListener('touchend', (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  touchStartX = null;
  if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1);
});

dialog.addEventListener('close', () => {
  document.documentElement.classList.remove('lb-open');
  photo.removeAttribute('src');
  photo.classList.remove('is-ready');
  // Return focus to the tile of the photo that was on screen (it may differ from the one opened).
  if (currentItem) linkOf(currentItem).focus();
  currentItem = null;
});

// Without JavaScript the tiles open the photo file; with it they open the viewer.
items.forEach((item) => linkOf(item).setAttribute('aria-haspopup', 'dialog'));

// ---------- The owner's photos ----------
const CATEGORY_LABELS = { exterior: 'Exterior', interior: 'Interior', wheels: 'Wheels', detail: 'Detail' };
const TILE_SIZES = '(max-width: 639px) calc(100vw - 40px), (max-width: 1023px) calc(50vw - 40px), 960px';

function photoItem(p, i) {
  const { image } = p;
  const largest = image.sizes.length ? image.sizes[image.sizes.length - 1].url : image.src;
  // Portrait photos span two rows and panoramas two columns; otherwise a steady rhythm like the built-in layout.
  let shape = i % 7 === 0 ? ' g-tall' : i % 7 === 4 ? ' g-wide' : '';
  if (image.height > image.width * 1.1) shape = ' g-tall';
  else if (image.width >= image.height * 1.9) shape = ' g-wide';
  const label = CATEGORY_LABELS[p.category] || p.category;
  return el('li', { class: `g-item${shape}`, 'data-category': p.category },
    el('figure', { class: 'g-tile' },
      el('a', { class: 'g-link', href: largest, 'aria-haspopup': 'dialog' },
        el('img', { src: image.src, srcset: image.srcset, sizes: TILE_SIZES, width: image.width, height: image.height, alt: p.caption || `${label} valeting photo`, loading: i < 3 ? 'eager' : 'lazy', decoding: 'async' })),
      el('figcaption', { class: 'g-cap' }, el('span', { class: 'g-cap-title', text: p.caption || `${label} finish` }), el('span', { class: 'label', text: label }))));
}

async function loadOwnPhotos() {
  let data;
  try {
    data = await api.gallery();
  } catch {
    return; // keep the built-in photos
  }
  if (!data.photos || !data.photos.length) return;
  if (dialog.open) dialog.close();
  grid.replaceChildren(...data.photos.map(photoItem));
  items = [...grid.querySelectorAll('.g-item')];
  recount();
  const note = document.querySelector('[data-g-note]');
  if (note) note.hidden = true;
  const pressed = chips.find((chip) => chip.getAttribute('aria-pressed') === 'true');
  applyFilter(pressed && !pressed.hidden ? pressed.dataset.filter : 'all', { updateUrl: false });
}
loadOwnPhotos();
