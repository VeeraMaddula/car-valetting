// Thin client for the booking API. Every call sends the session cookie, times out instead of hanging,
// and throws ApiError with a message that is safe to show to customers.
import { API_BASE, BUSINESS } from './config.js';

export class ApiError extends Error {
  constructor(status, code, message, fields = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request(method, path, { body, headers = {}, timeout = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK', err.name === 'AbortError'
      ? 'This is taking longer than usual. Please check your connection and try again.'
      : `We couldn't reach the booking system. Please check your connection, or call us on ${BUSINESS.phone}.`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data && data.error;
    throw new ApiError(res.status, (e && e.code) || `HTTP_${res.status}`, (e && e.message) || `Something went wrong. Please try again, or call ${BUSINESS.phone}.`, (e && e.fields) || {});
  }
  return data;
}

/** A fresh key per booking attempt, so a retried request never creates a second booking. */
export function newIdempotencyKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

const CONFIG_KEY = 'sjp-config-v1';

export const api = {
  /** Services, slot labels/times and booking rules. Cached for 5 minutes in this tab. */
  async config() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CONFIG_KEY) || 'null');
      if (cached && cached.at > Date.now() - 5 * 60_000) return cached.data;
    } catch { /* storage unavailable */ }
    const data = await request('GET', '/config');
    try { sessionStorage.setItem(CONFIG_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
    return data;
  },
  availability: (from, to) => request('GET', `/availability?from=${from}&to=${to}`),
  createBooking: (body, idempotencyKey) => request('POST', '/bookings', { body, headers: { 'Idempotency-Key': idempotencyKey }, timeout: 20000 }),
  track: (reference, phone) => request('POST', '/bookings/track', { body: { reference, phone } }),
  cancelTracked: (reference, phone, reason) => request('POST', '/bookings/track/cancel', { body: { reference, phone, reason: reason || null } }),

  me: () => request('GET', '/auth/me'),
  register: (body) => request('POST', '/auth/register', { body }),
  login: (login, password) => request('POST', '/auth/login', { body: { login, password } }),
  logout: () => request('POST', '/auth/logout', { body: {} }),
  forgotPassword: (email) => request('POST', '/auth/password/forgot', { body: { email } }),
  resetPassword: (token, password) => request('POST', '/auth/password/reset', { body: { token, password } }),

  myBookings: () => request('GET', '/me/bookings'),
  myBooking: (reference) => request('GET', `/me/bookings/${encodeURIComponent(reference)}`),
  cancelMine: (reference, reason) => request('POST', `/me/bookings/${encodeURIComponent(reference)}/cancel`, { body: { reason: reason || null } }),
  claim: (reference, phone) => request('POST', '/me/bookings/claim', { body: { reference, phone } }),
};
