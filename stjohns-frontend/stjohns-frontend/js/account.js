// Sign in, create an account or ask for a password reset link. After signing in, go to ?next= (a page on this site).
import { api } from './api.js';
import { clearFieldError, currentUser, el, param, showFieldErrors, toast } from './ui.js';

const DEFAULT_NEXT = 'my-bookings.html';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME = /^[a-z0-9._-]{3,30}$/;
const STRENGTH = ['At least 10 characters. A short phrase works well.', 'Too short — at least 10 characters', 'Good password', 'Strong password'];

const views = [...document.querySelectorAll('[data-view]')];
const tabs = [...document.querySelectorAll('[role="tab"]')];
const tablist = document.querySelector('[role="tablist"]');
const guest = document.querySelector('[data-guest]');
const forms = Object.fromEntries([...document.querySelectorAll('[data-form]')].map((f) => [f.dataset.form, f]));

/** Only a page on this site such as 'my-bookings.html' or 'booking.html?service=full'; anything else falls back. */
function safeNext(raw) {
  if (!raw || !/^[a-z0-9][a-z0-9-]*\.html(?:[?#][^\s\\]*)?$/i.test(raw)) return DEFAULT_NEXT;
  if (/^(account|reset-password)\.html/i.test(raw)) return DEFAULT_NEXT;
  try {
    return new URL(raw, location.href).origin === location.origin ? raw : DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }
}
const next = safeNext(param('next'));
const DASHBOARD = 'admin.html';
// account.html?invite=… comes from a team invite email.
const inviteToken = /^[A-Za-z0-9_-]{20,100}$/.test(param('invite') || '') ? param('invite') : null;
const inviteNotice = document.querySelector('[data-invite]');
/** Where to go after signing in: team members land on the dashboard unless a page asked for them. */
const afterSignIn = (user) => (user && user.role !== 'customer' && next === DEFAULT_NEXT ? DASHBOARD : next);

function firstName(user) {
  return (user.fullName || '').trim().split(/\s+/)[0] || user.username;
}

function setBusy(button, busy) {
  button.setAttribute('aria-disabled', String(busy));
  button.setAttribute('aria-busy', String(busy));
  const spinner = button.querySelector('.spinner');
  if (busy && !spinner) button.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  if (!busy && spinner) spinner.remove();
}
const isBusy = (button) => button.getAttribute('aria-busy') === 'true';

function setFormError(form, message) {
  form.querySelector('[data-form-error]').textContent = message;
}

// ---------- Views ----------

function hidePasswords() {
  document.querySelectorAll('.toggle-pw').forEach((btn) => {
    document.getElementById(btn.getAttribute('aria-controls')).type = 'password';
    btn.setAttribute('aria-pressed', 'false');
  });
}

/** Show one view. focus: 'heading' (default), 'tab' (keyboard use of the tabs) or false (page load). */
function go(view, { focus = 'heading' } = {}) {
  views.forEach((v) => { v.hidden = v.dataset.view !== view; });
  const tabbed = view === 'signin' || view === 'register';
  tablist.hidden = !tabbed;
  guest.hidden = !tabbed || Boolean(inviteToken);
  inviteNotice.hidden = !(tabbed && inviteToken);
  tabs.forEach((t) => {
    const on = t.dataset.tab === view;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  hidePasswords();
  if (['signin', 'register', 'forgot'].includes(view)) {
    const url = new URL(location.href);
    if (view === 'signin') url.searchParams.delete('mode');
    else url.searchParams.set('mode', view);
    history.replaceState(null, '', url);
    document.title = `${{ signin: 'Sign in', register: 'Create account', forgot: 'Reset password' }[view]} · St Johns Park Car Valeting`;
  }
  const active = views.find((v) => v.dataset.view === view);
  if (focus === 'tab') tabs.find((t) => t.dataset.tab === view).focus();
  else if (focus) active.querySelector('.auth-title').focus();
}

tabs.forEach((tab) => tab.addEventListener('click', () => go(tab.dataset.tab, { focus: 'tab' })));
tablist.addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  go(tabs[(to + tabs.length) % tabs.length].dataset.tab, { focus: 'tab' });
});
document.querySelectorAll('[data-go]').forEach((btn) => btn.addEventListener('click', () => go(btn.dataset.go)));

// ---------- Password fields ----------

document.querySelectorAll('.toggle-pw').forEach((btn) => {
  const input = document.getElementById(btn.getAttribute('aria-controls'));
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
  });
});

const strengthScore = (pw) => (!pw ? 0 : pw.length < 10 ? 1 : pw.length < 15 ? 2 : 3);
const regPassword = forms.register.elements.password;
regPassword.addEventListener('input', () => {
  const field = regPassword.closest('.field');
  const score = strengthScore(regPassword.value);
  field.querySelector('.pw-meter').dataset.score = score;
  const label = field.querySelector('.pw-strength');
  label.dataset.score = score;
  label.textContent = STRENGTH[score];
});

Object.values(forms).forEach((form) => {
  form.addEventListener('input', (e) => { if (e.target.matches('input')) clearFieldError(e.target); });
});

/** Run a form's API call with a busy button and the standard error handling. Returning true keeps it busy (navigating away). */
async function run(form, action, onError) {
  const button = form.querySelector('[type="submit"]');
  let navigating = false;
  setFormError(form, '');
  setBusy(button, true);
  try {
    navigating = Boolean(await action());
  } catch (err) {
    if (onError && onError(err)) return;
    if (['VALIDATION_FAILED', 'CONFLICT'].includes(err.code) && showFieldErrors(form, err.fields)) return;
    setFormError(form, err.message);
  } finally {
    if (!navigating) setBusy(button, false);
  }
}

// ---------- Sign in ----------

forms.signin.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = forms.signin;
  if (isBusy(form.querySelector('[type="submit"]'))) return;
  const login = form.elements.login.value.trim();
  const password = form.elements.password.value;
  const errors = {};
  if (!login) errors.login = 'Enter your username or email';
  if (!password) errors.password = 'Enter your password';
  setFormError(form, '');
  if (showFieldErrors(form, errors)) return;
  run(form, async () => {
    const { user } = await api.login(login, password);
    if (inviteToken) {
      // Signed in now either way; if the invite can't be used, the invite view explains why.
      try {
        await api.acceptInvite(inviteToken);
      } catch (err) {
        showInvite(user, err.message);
        return false;
      }
      location.assign(DASHBOARD);
      return true;
    }
    location.assign(afterSignIn(user));
    return true;
  }, (err) => {
    if (err.code !== 'UNAUTHENTICATED') return false;
    setFormError(form, err.message);
    form.elements.password.focus();
    form.elements.password.select();
    return true;
  });
});

// ---------- Create account ----------

forms.register.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = forms.register;
  if (isBusy(form.querySelector('[type="submit"]'))) return;
  const body = {
    fullName: form.elements.fullName.value.trim(),
    username: form.elements.username.value.trim().toLowerCase(),
    email: form.elements.email.value.trim(),
    phone: form.elements.phone.value.trim(),
    password: form.elements.password.value,
    ...(inviteToken ? { inviteToken } : {}),
  };
  const errors = {};
  if (body.fullName.length < 2) errors.fullName = 'Enter your name';
  if (!USERNAME.test(body.username)) errors.username = 'Use 3–30 letters, numbers, dots, dashes or underscores';
  if (!EMAIL.test(body.email)) errors.email = 'Enter a valid email address';
  if (body.phone.replace(/\D/g, '').length < 9) errors.phone = 'Enter a valid mobile number';
  if (body.password.length < 10) errors.password = 'Use at least 10 characters';
  else if (body.password.toLowerCase() === body.username) errors.password = 'Password must not be your username';
  setFormError(form, '');
  if (showFieldErrors(form, errors)) return;
  run(form, async () => {
    await api.register(body);
    location.assign(inviteToken ? DASHBOARD : next);
    return true;
  }, (err) => {
    // "Already registered" is terse on its own; the full message points to signing in.
    if (err.code === 'CONFLICT' && err.fields && err.fields.email) return showFieldErrors(form, { email: err.message });
    return false;
  });
});

// ---------- Forgot password ----------

forms.forgot.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = forms.forgot;
  if (isBusy(form.querySelector('[type="submit"]'))) return;
  const email = form.elements.email.value.trim();
  setFormError(form, '');
  if (showFieldErrors(form, EMAIL.test(email) ? {} : { email: 'Enter a valid email address' })) return;
  run(form, async () => {
    await api.forgotPassword(email);
    document.querySelector('[data-sent-email]').textContent = email;
    go('sent');
  });
});

// ---------- Already signed in ----------

function showSignedIn(user) {
  const name = firstName(user);
  document.querySelector('[data-done-text]').textContent = `Good to see you again, ${name}. Your bookings are waiting.`;
  const nextLink = document.querySelector('[data-done-next]');
  const target = afterSignIn(user);
  nextLink.href = target;
  nextLink.textContent = target === DASHBOARD ? 'Open dashboard' : target === DEFAULT_NEXT ? 'My bookings' : 'Continue';
  document.querySelector('[data-sign-out]').textContent = `Not ${name}? Sign out`;
  document.title = 'Signed in · St Johns Park Car Valeting';
  go('done', { focus: false });
}

document.querySelector('[data-sign-out]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    await api.logout();
    toast("You've signed out.");
    go('signin');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
});

// ---------- Team invite (already signed in) ----------

const inviteError = document.querySelector('[data-invite-error]');

function showInvite(user, error = '') {
  document.querySelector('[data-invite-text]').textContent = `You're signed in as ${firstName(user)} (${user.email}). Accept the invite to open the St Johns Park dashboard.`;
  inviteError.textContent = error;
  document.title = 'Join the team · St Johns Park Car Valeting';
  go('invite', { focus: error ? 'heading' : false });
}

document.querySelector('[data-invite-accept]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (isBusy(button)) return;
  setBusy(button, true);
  inviteError.textContent = '';
  try {
    await api.acceptInvite(inviteToken);
    location.assign(DASHBOARD);
  } catch (err) {
    // FORBIDDEN: the invite was sent to a different email; VALIDATION_FAILED: expired or already used.
    inviteError.textContent = err.message;
    setBusy(button, false);
  }
});

document.querySelector('[data-invite-sign-out]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (isBusy(button)) return;
  setBusy(button, true);
  try {
    await api.logout();
    go('signin');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    setBusy(button, false);
  }
});

// ---------- Start ----------

const modes = { register: 'register', forgot: 'forgot' };
// New team members usually don't have an account yet.
const initialView = modes[param('mode')] || (inviteToken ? 'register' : 'signin');
go(initialView, { focus: false });

currentUser().then((user) => {
  if (!user) return;
  if (inviteToken) {
    showInvite(user);
    return;
  }
  // "Change password" from My bookings lands here: keep the reset form and fill in their email.
  if (initialView === 'forgot') {
    const email = forms.forgot.elements.email;
    if (!email.value) email.value = user.email;
    return;
  }
  // Don't yank the form away from someone who has already started typing.
  const typing = [...document.querySelectorAll('[data-form] input')].some((i) => i.value);
  if (!typing) showSignedIn(user);
});
