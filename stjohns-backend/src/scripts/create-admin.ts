// Create the owner's admin account, or promote an existing user to admin.
// Usage: npm run create-admin     (asks for each detail; the password is hidden as you type)
// Non-interactive, e.g. on a server (the password comes from the environment, never the command line):
//   ADMIN_PASSWORD='…' node dist/scripts/create-admin.js --username owner --email you@example.com --name "Your Name" --phone "089 470 9672"
// Note: PowerShell drops the `--` in `npm run create-admin -- --username …`; use `npm.cmd run create-admin -- …` there.
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { hashPassword, registerSchema } from '../domain/users.js';
import { normalizePhone } from '../lib/phone.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    phone: { type: 'string' },
  },
});
const fields = registerSchema.shape;

// ---------- Prompts (opened only when a detail is missing) ----------

let rl: Interface | undefined;
let lines: AsyncIterator<string> | undefined;
let muted = false;

async function ask(prompt: string, hidden = false): Promise<string> {
  if (!rl) {
    // readline echoes typing through this stream, so it can be silenced while a password is typed.
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      process.exit(130);
    });
    lines = rl[Symbol.asyncIterator]();
  }
  rl.setPrompt(prompt);
  rl.prompt();
  muted = hidden;
  const next = await lines!.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (next.done) throw new Error('No input. Pass --username, --email, --name and --phone, and set ADMIN_PASSWORD.');
  return hidden ? next.value : next.value.trim();
}

function firstIssue(result: { success: boolean; error?: { issues: { message: string }[] } }): string | undefined {
  return result.success ? undefined : (result.error?.issues[0]?.message ?? 'Not valid');
}

/** Use the command-line value if it is valid, otherwise ask until it is. */
async function detail(given: string | undefined, prompt: string, check: (v: string) => string | undefined): Promise<string> {
  let value = given?.trim();
  for (;;) {
    if (value) {
      const problem = check(value);
      if (!problem) return value;
      console.log(`  ${problem}`);
    }
    value = await ask(prompt);
  }
}

/** ADMIN_PASSWORD if set, otherwise ask twice (hidden). Optional passwords may be left blank. */
async function newPassword(username: string, optional: boolean): Promise<string | undefined> {
  const check = (pw: string) => firstIssue(fields.password.safeParse(pw)) ?? (pw.toLowerCase() === username ? 'Password must not be your username' : undefined);
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) {
    const problem = check(fromEnv);
    if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
    return fromEnv;
  }
  if (optional && !process.stdin.isTTY) return undefined;
  for (;;) {
    const pw = await ask(optional ? 'New password (press Enter to keep the current one): ' : 'Password (at least 10 characters, hidden): ', true);
    if (!pw && optional) return undefined;
    const problem = check(pw);
    if (problem) {
      console.log(`  ${problem}`);
      continue;
    }
    if ((await ask('Repeat the password: ', true)) !== pw) {
      console.log("  The passwords didn't match. Try again.");
      continue;
    }
    return pw;
  }
}

// ---------- Main ----------

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const username = (await detail(values.username, 'Username (e.g. owner): ', (v) => firstIssue(fields.username.safeParse(v)))).toLowerCase();
    const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);

    if (existing.rows[0]) {
      console.log(`"${username}" already exists and will be made an admin.`);
      const password = await newPassword(username, true);
      const hash = password ? await hashPassword(password) : null;
      await pool.query("UPDATE users SET role = 'admin', password_hash = COALESCE($2, password_hash), updated_at = now() WHERE id = $1", [
        existing.rows[0].id,
        hash,
      ]);
      console.log(`\n"${username}" is now an admin${hash ? ' (password updated)' : ''}.`);
      return;
    }

    const email = (await detail(values.email, 'Email: ', (v) => firstIssue(fields.email.safeParse(v)))).toLowerCase();
    const name = await detail(values.name, 'Full name: ', (v) => firstIssue(fields.fullName.safeParse(v)));
    const phoneInput = await detail(values.phone, 'Mobile number (e.g. 089 470 9672): ', (v) =>
      normalizePhone(v) ? undefined : 'Enter a valid phone number, e.g. 089 470 9672',
    );
    const password = (await newPassword(username, false))!;
    try {
      await pool.query("INSERT INTO users (username, email, full_name, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'admin')", [
        username,
        email,
        name,
        normalizePhone(phoneInput)!.e164,
        await hashPassword(password),
      ]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new Error(`${email} already belongs to another account. Run again with that account's username to make it an admin.`);
      }
      throw err;
    }
    console.log(`\nAdmin "${username}" created. Sign in on the website with this username and password.`);
  } finally {
    rl?.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
