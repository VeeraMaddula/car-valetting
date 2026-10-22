import type { Queryable } from '../db/pool.js';

export type NotifyChannel = 'customer_email' | 'customer_sms' | 'owner_email' | 'owner_sms';
export type NotifyTemplate =
  | 'created'
  | 'confirmed'
  | 'cancelled'
  | 'cancelled_by_customer'
  | 'reminder'
  | 'deposit_requested'
  | 'deposit_paid'
  | 'deposit_refunded'
  | 'deposit_refund_failed'
  | 'completed'
  | 'review_request';

export type JobInput =
  | { kind: 'notify'; payload: { bookingId: string; channel: NotifyChannel; template: NotifyTemplate }; runAt?: Date }
  | { kind: 'gcal.sync'; payload: { bookingId: string }; runAt?: Date }
  | { kind: 'auth.password_reset'; payload: { userId: string; token: string }; runAt?: Date }
  | { kind: 'deposit.link'; payload: { bookingId: string }; runAt?: Date }
  | { kind: 'deposit.expire'; payload: { bookingId: string; sessionId: string }; runAt?: Date }
  /** `check` counts follow-up checks on a refund Stripe still has pending. */
  | { kind: 'deposit.refund'; payload: { bookingId: string; check?: number }; runAt?: Date }
  | { kind: 'owner.daily_summary'; payload: { date: string }; runAt?: Date }
  | { kind: 'team.invite'; payload: { inviteId: string; token: string }; runAt?: Date };

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
