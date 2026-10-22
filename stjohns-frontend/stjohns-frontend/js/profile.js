// My profile: update personal details, download a copy of your data, or delete your account (GDPR).
import { api, ApiError } from './api.js';
import { clearFieldError, currentUser, el, fmt, showFieldErrors, toast } from './ui.js';

const COUNTIES = [
  'Carlow', 'Cavan', 'Clare', 'Cork', 'Donegal', 'Dublin', 'Galway', 'Kerry', 'Kildare', 'Kilkenny', 'Laois', 'Leitrim', 'Limerick',
  'Longford', 'Louth', 'Mayo', 'Meath', 'Monaghan', 'Offaly', 'Roscommon', 'Sligo', 'Tipperary', 'Waterford', 'Westmeath', 'Wexford', 'Wicklow',
];
const GENERIC = 'Something went wrong. Please try again, or call 089 470 9672.';

const $ = (selector, root = document) => root.querySelector(selector);
const form = $('[data-profile-form]');
const field = (name) => form.elements[name];
const deleteForm = $('[data-delete-form]');
let saved = null; // the profile as last loaded or saved

function setFormError(target, message) {
  $('[data-form-error]', target).textContent = message || '';
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  const spinner = button.querySelector('.spinner');
  if (busy && !spinner) button.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  if (!busy && spinner) spinner.remove();
}

/** Field messages next to their inputs; anything else in the form's notice. */
function showError(target, err) {
  if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') {
    location.replace('account.html?next=profile.html');
    return;
  }
  const fields = (err instanceof ApiError && err.fields) || {};
  const shown = showFieldErrors(target, fields);
  setFormError(target, shown ? '' : err instanceof ApiError ? err.message : GENERIC);
}

// ---------- Personal details ----------

function buildCounties(current) {
  const select = field('county');
  const options = [['', 'Choose a county'], ...COUNTIES.map((c) => [c, c])];
  // Keep a county saved in a different form (e.g. "Co. Cork") rather than dropping it.
  if (current && !COUNTIES.includes(current)) options.push([current, current]);
  select.replaceChildren(...options.map(([value, label]) => el('option', { value, text: label })));
  select.value = current || '';
}

function fill(p) {
  saved = p;
  field('fullName').value = p.fullName;
  field('email').value = p.email;
  field('phone').value = p.phone;
  field('dateOfBirth').value = p.dateOfBirth || '';
  field('addressLine1').value = p.address.line1 || '';
  field('addressLine2').value = p.address.line2 || '';
  field('town').value = p.address.town || '';
  field('eircode').value = p.address.eircode || '';
  buildCounties(p.address.county);
  field('currentPassword').value = '';
  $('[data-password-field]').hidden = true;
  $('[data-username]').textContent = p.username;
  $('[data-member-since]').textContent = `${fmt.monthShort(p.memberSince.slice(0, 10))} ${p.memberSince.slice(0, 4)}`;
  showName(p.fullName);
}

function showName(fullName) {
  const words = fullName.trim().split(/\s+/);
  $('[data-initials]').textContent = ((words[0] || '').charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : '')).toUpperCase();
  $('[data-user-name]').textContent = fullName;
}

const emailChanged = () => saved && field('email').value.trim().toLowerCase() !== saved.email;

field('email').addEventListener('input', () => {
  const show = emailChanged();
  $('[data-password-field]').hidden = !show;
  if (!show) field('currentPassword').value = '';
});

form.addEventListener('input', (e) => {
  if (e.target.matches('input, select')) clearFieldError(e.target);
  $('[data-saved]').textContent = '';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('[data-save]');
  if (button.disabled) return;
  const value = (name) => field(name).value.trim();
  const body = {
    fullName: value('fullName'),
    email: value('email'),
    phone: value('phone'),
    dateOfBirth: value('dateOfBirth') || null,
    addressLine1: value('addressLine1') || null,
    addressLine2: value('addressLine2') || null,
    town: value('town') || null,
    county: value('county') || null,
    eircode: value('eircode') || null,
    ...(emailChanged() ? { currentPassword: field('currentPassword').value } : {}),
  };
  setFormError(form, '');
  setBusy(button, true);
  try {
    const { profile } = await api.updateProfile(body);
    fill(profile);
    $('[data-saved]').textContent = 'Saved.';
    toast('Your details are saved.');
  } catch (err) {
    showError(form, err);
  } finally {
    setBusy(button, false);
  }
});

// ---------- Your data ----------

$('[data-download]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  setBusy(button, true);
  try {
    const blob = await api.myData();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `st-johns-park-my-data-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') location.replace('account.html?next=profile.html');
    else toast(err instanceof ApiError ? err.message : GENERIC, { error: true });
  } finally {
    setBusy(button, false);
  }
});

// ---------- Delete my account ----------

const deleteStart = $('[data-delete-start]');
function showDelete(open) {
  deleteForm.hidden = !open;
  deleteStart.hidden = open;
  deleteStart.setAttribute('aria-expanded', String(open));
  if (open) deleteForm.elements.password.focus();
  else {
    deleteForm.reset();
    showFieldErrors(deleteForm, {});
    setFormError(deleteForm, '');
    deleteStart.focus();
  }
}
deleteStart.addEventListener('click', () => showDelete(true));
$('[data-delete-cancel]').addEventListener('click', () => showDelete(false));
deleteForm.addEventListener('input', (e) => clearFieldError(e.target));
deleteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = deleteForm.querySelector('[type="submit"]');
  const password = deleteForm.elements.password.value;
  setFormError(deleteForm, '');
  if (showFieldErrors(deleteForm, password ? {} : { password: 'Enter your password' })) return;
  setBusy(button, true);
  try {
    await api.deleteAccount(password);
    $('[data-signed-in]').hidden = true;
    $('[data-user-chip]').hidden = true;
    const done = $('[data-deleted]');
    done.hidden = false;
    $('h1', done).focus();
  } catch (err) {
    showError(deleteForm, err);
    setBusy(button, false);
  }
});

// ---------- Header ----------

$('[data-sign-out]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  setBusy(button, true);
  try {
    await api.logout();
    location.assign('index.html');
  } catch (err) {
    toast(err instanceof ApiError ? err.message : GENERIC, { error: true });
    setBusy(button, false);
  }
});

// ---------- Start ----------

async function load() {
  $('[data-load-error]').hidden = true;
  $('[data-loading]').hidden = false;
  try {
    const { profile } = await api.profile();
    fill(profile);
    $('[data-signed-in]').hidden = false;
    $('[data-user-chip]').hidden = false;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') {
      location.replace('account.html?next=profile.html');
      return;
    }
    $('[data-load-error-text]').textContent = `We couldn't load your profile. ${err instanceof ApiError ? err.message : GENERIC}`;
    $('[data-load-error]').hidden = false;
  } finally {
    $('[data-loading]').hidden = true;
  }
}
$('[data-retry]').addEventListener('click', load);

field('dateOfBirth').max = new Date().toISOString().slice(0, 10);
currentUser().then((user) => {
  if (!user) location.replace('account.html?next=profile.html');
  else load();
});
