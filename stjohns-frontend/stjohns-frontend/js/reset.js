// Choose a new password from the emailed reset link (reset-password.html?token=…).
import { api } from './api.js';
import { clearFieldError, el, param, showFieldErrors } from './ui.js';

const STRENGTH = ['At least 10 characters. A short phrase works well.', 'Too short — at least 10 characters', 'Good password', 'Strong password'];

const views = [...document.querySelectorAll('[data-view]')];
const form = document.querySelector('[data-form="reset"]');
const submitBtn = form.querySelector('[type="submit"]');
const password = form.elements.password;
const confirm = form.elements.confirm;

// Read the token once, then drop it from the address bar so it never lands in history, screenshots or analytics.
const token = param('token');
if (token) history.replaceState(null, '', location.pathname);

function go(view, { focus = true } = {}) {
  views.forEach((v) => { v.hidden = v.dataset.view !== view; });
  if (focus) views.find((v) => v.dataset.view === view).querySelector('.auth-title').focus();
}

function setBusy(button, busy) {
  button.setAttribute('aria-disabled', String(busy));
  button.setAttribute('aria-busy', String(busy));
  const spinner = button.querySelector('.spinner');
  if (busy && !spinner) button.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  if (!busy && spinner) spinner.remove();
}

function setFormError(message) {
  form.querySelector('[data-form-error]').textContent = message;
}

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
password.addEventListener('input', () => {
  const field = password.closest('.field');
  const score = strengthScore(password.value);
  field.querySelector('.pw-meter').dataset.score = score;
  const label = field.querySelector('.pw-strength');
  label.dataset.score = score;
  label.textContent = STRENGTH[score];
});

form.addEventListener('input', (e) => { if (e.target.matches('input')) clearFieldError(e.target); });

// ---------- Submit ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitBtn.getAttribute('aria-busy') === 'true') return;
  const errors = {};
  if (password.value.length < 10) errors.password = 'Use at least 10 characters';
  if (!confirm.value) errors.confirm = 'Enter the new password again';
  else if (confirm.value !== password.value) errors.confirm = "Passwords don't match";
  setFormError('');
  if (showFieldErrors(form, errors)) return;

  setBusy(submitBtn, true);
  try {
    await api.resetPassword(token, password.value);
    form.reset();
    go('done');
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED' && err.fields && err.fields.token) {
      go('expired');
    } else if (!(err.code === 'VALIDATION_FAILED' && showFieldErrors(form, err.fields))) {
      setFormError(err.message);
    }
  } finally {
    setBusy(submitBtn, false);
  }
});

go(token ? 'form' : 'missing', { focus: false });
