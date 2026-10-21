export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SLOT_UNAVAILABLE'
  | 'CONFLICT'
  | 'CANCELLATION_CLOSED'
  | 'INVALID_TRANSITION'
  | 'BOOKING_PAUSED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SLOT_UNAVAILABLE: 409,
  CONFLICT: 409,
  CANCELLATION_CLOSED: 409,
  INVALID_TRANSITION: 409,
  BOOKING_PAUSED: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL: 500,
};

/** An error that is safe to show to the client. */
export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS[code];
  }
}

/** Postgres/CockroachDB unique violation, optionally for one named constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== '23505') return false;
  if (!constraint) return true;
  return e.constraint === constraint || (e.message ?? '').includes(`"${constraint}"`);
}

/** Error from a third-party provider that will not succeed if retried (e.g. an invalid number). */
export class PermanentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProviderError';
  }
}
