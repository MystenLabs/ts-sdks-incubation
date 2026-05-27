import { Schedule } from 'effect';

export interface ExponentialRetryOptions {
	readonly initialDelayMs: number;
	readonly maxRetries: number;
	readonly factor?: number;
	readonly jitter?: boolean;
}

export const makeExponentialRetrySchedule = (options: ExponentialRetryOptions) => {
	const schedule = Schedule.exponential(`${options.initialDelayMs} millis`, options.factor ?? 2);
	const jittered = options.jitter === false ? schedule : schedule.pipe(Schedule.jittered);
	return jittered.pipe(Schedule.both(Schedule.recurs(options.maxRetries)));
};

export const makeSpacedRetrySchedule = (delayMs: number, maxRetries: number) =>
	Schedule.spaced(`${delayMs} millis`).pipe(Schedule.both(Schedule.recurs(maxRetries)));

/** Wall-clock-bounded fixed-interval poll. Selects "poll every
 *  `intervalMs` until total elapsed ≥ `timeoutMs`". Returns a
 *  schedule that callers compose with `Effect.repeat` /
 *  `Effect.retry` for poll-until-ready loops where the exit
 *  condition is owned by the caller body.
 *
 *  Use for balance polls, post-funding settlement waits, and any
 *  similar wall-clock-bounded reconciliation loops. */
export const makeBoundedSpacedSchedule = (intervalMs: number, timeoutMs: number) =>
	Schedule.both(Schedule.spaced(`${intervalMs} millis`), Schedule.during(`${timeoutMs} millis`));

/** Balance-poll profile shared by funding settlement waits. The
 *  interval is short enough to keep wall-clock overshoot small;
 *  the timeout is the canonical funding settlement budget. */
export const BALANCE_POLL_PROFILE = {
	intervalMs: 250,
	timeoutMs: 30_000,
} as const;

/** Single-call deadline for the per-poll balance-reader. Faucet
 *  RPC calls occasionally hang; the deadline keeps a stalled
 *  read from starving the surrounding poll loop. */
export const FUNDING_BALANCE_READ_TIMEOUT_MS = 5_000;

/** Docker Desktop bind-mount visibility race. The host directory
 *  is just-created but the Docker VFS hasn't surfaced it yet;
 *  attempts cap at 5s total (10 × 500ms). */
export const DEPLOY_BIND_SOURCE_RETRY_PROFILE = {
	attempts: 10,
	delayMs: 500,
} as const;

/** HTTP faucet POST retry profile. The faucet's TCP socket binds
 *  before the validator can transfer coins (a 60s cold-warm
 *  window). `attempts × backoff` saturates well inside the
 *  surrounding wall-clock budget. */
export const FAUCET_HTTP_RETRY_PROFILE = {
	maxAttempts: 15,
	initialDelayMs: 500,
	backoffFactor: 1.5,
	wallClockBudgetMs: 90_000,
	perRequestDeadlineMs: 5_000,
} as const;

/** Sui "stale object version" retry profile — used when a Move call
 *  references an object that's been mutated by a concurrent transaction
 *  (deepbook pool seeding hits this when the registry / pool object is
 *  re-versioned mid-flight). The retry rebuilds the transaction with
 *  fresh refs each attempt; 20 × 500ms keeps the worst case under 10s. */
export const STALE_OBJECT_VERSION_RETRY_PROFILE = {
	attempts: 20,
	delayMs: 500,
} as const;

/** Docker `network rm` retry profile — used by best-effort network
 *  prune after our own endpoints are force-disconnected. Foreign
 *  holders and stale bridge-driver endpoints may keep the network
 *  busy for a short window; 6 × 250ms saturates well inside the
 *  prune wall-clock budget while letting transient races resolve.
 *  Callers may override per-invocation via
 *  `DevstackNetworkRemovalOptions`. */
export const NETWORK_REMOVE_RETRY_PROFILE = {
	attempts: 6,
	delayMs: 250,
} as const;
