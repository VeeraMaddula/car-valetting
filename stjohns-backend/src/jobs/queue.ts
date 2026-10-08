import type { Queryable } from '../db/pool.js';

export type NotifyChannel = 'customer_email' | 'customer_sms' | 'owner_email' | 'owner_sms';
export type NotifyTemplate =
  | 'created'
  | 'confirmed'
  | 'cancelled'
  | 'cancelled_by_customer'
  | 'reminder'
  | 'deposit_requested'
  | 'completed';

export type JobInput =
  | { kind: 'notify'; payload: { bookingId: string; channel: NotifyChannel; template: NotifyTemplate }; runAt?: Date }
  | { kind: 'gcal.sync'; payload: { bookingId: string }; runAt?: Date }
  | { kind: 'auth.password_reset'; payload: { userId: string; token: string }; runAt?: Date };

export type JobKind = JobInput['kind'];

/** Insert jobs in the caller's transaction (transactional outbox). */
export async function enqueue(db: Queryable, jobs: JobInput[]): Promise<void> {
  if (jobs.length === 0) return;
  const params: unknown[] = [];
  const rows = jobs.map((job, i) => {
    params.push(job.kind, JSON.stringify(job.payload), job.runAt ?? new Date());
    return `($${i * 3 + 1}, $${i * 3 + 2}::JSONB, $${i * 3 + 3})`;
  });
  await db.query(`INSERT INTO jobs (kind, payload, run_at) VALUES ${rows.join(', ')}`, params);
}
