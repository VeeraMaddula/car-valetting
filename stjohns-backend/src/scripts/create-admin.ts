// Create the owner's admin account, or promote an existing user to admin.
// Usage (password via env so it never lands in shell history):
//   ADMIN_PASSWORD='…' npm run create-admin -- --username owner --email you@example.com --name "Your Name" --phone "089 470 9672"
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { hashPassword } from '../domain/users.js';
import { normalizePhone } from '../lib/phone.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    phone: { type: 'string' },
  },
});

const username = values.username?.trim().toLowerCase();
const email = values.email?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!username || !/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('--username is required (3–30 letters, numbers, . _ -)');

const pool = createPool(loadConfig());
try {
  const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows[0]) {
    const hash = password ? await hashPassword(password) : null;
    await pool.query("UPDATE users SET role = 'admin', password_hash = COALESCE($2, password_hash), updated_at = now() WHERE id = $1", [
      existing.rows[0].id,
      hash,
    ]);
    console.log(`"${username}" is now an admin${hash ? ' (password updated)' : ''}.`);
  } else {
    if (!email || !values.name || !values.phone) throw new Error('New admins need --email, --name and --phone');
    if (!password || password.length < 10) throw new Error('Set ADMIN_PASSWORD (at least 10 characters)');
    const phone = normalizePhone(values.phone);
    if (!phone) throw new Error('--phone is not a valid phone number');
    await pool.query(
      "INSERT INTO users (username, email, full_name, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'admin')",
      [username, email, values.name.trim(), phone.e164, await hashPassword(password)],
    );
    console.log(`Admin "${username}" created.`);
  }
} finally {
  await pool.end();
}
