// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChainDefinition } from '../chains/types.js';
import { parseMessageV2 } from '../utils/bytes.js';
import { sleep, untilAborted } from '../utils/sleep.js';

/**
 * 0.1 USDC in base units, net of fees. The claimer refuses anything less as `below_minimum`, and
 * says so only when asked to claim, so this follows `MIN_CLAIM_AMOUNT` in its `src/message.ts`.
 */
export const MIN_SPONSORED_AMOUNT = 100_000n;

const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
// The wait before each retry, before the jitter. The rate limit in front of the service lasts
// about a minute, so the last one has to be able to land past it.
const RETRY_DELAYS_MS = [3_000, 20_000, 60_000];
const MAX_RETRY_AFTER_MS = 90_000;
// The function's own limit is 15 s, so this only ends an attempt nothing will answer.
const ATTEMPT_TIMEOUT_MS = 20_000;
// Room for all three waits and the attempts between them, so the third retry can still start.
const TOTAL_LIMIT_MS = 120_000;

const TIMED_OUT = new Error('The sponsor did not answer in time');

export interface SponsorConfig {
	/** The deployment's origin, for the kit's network: one deployment serves one Sui network. */
	baseUrl: string;
	fetch?: typeof fetch;
}

export interface SponsorClientOptions extends SponsorConfig {
	/** Told about every status that is read, whatever it found. */
	onStatus?: (status: SponsorStatus) => void;
	/** The wait between attempts. Rejects when `signal` aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** The clock the status age and the overall limit are measured on. */
	now?: () => number;
	/** The jitter on the wait between attempts, in [0, 1). */
	random?: () => number;
}

/** What the sponsor last said about itself. */
export interface SponsorStatus {
	/** The answer of `/api/health`, or null when there was none that could be read. */
	health: { ok: boolean; dryRun: boolean } | null;
	/** The source domains on `/api/denylist`, or null until a list has been read. */
	deniedDomains: number[] | null;
	/** When this was read. */
	checkedAt: number;
}

/** What came back from one attempt: a response with its body, or no response at all. */
export type SponsorAnswer =
	/** `body` is the parsed JSON, and left out when the body is not JSON. */
	{ status: number; body?: unknown } | { failed: 'network' | 'timeout' };

/**
 * Why the sponsor did not claim. `refused`: it answered, and will not claim this message.
 * `unavailable`: it could not, and may be able to later.
 */
export type SponsorFailure = 'refused' | 'unavailable';

export type SponsorVerdict =
	| { action: 'claimed'; digest: string }
	| { action: 'alreadyClaimed' }
	| { action: 'retry'; reason: string }
	| { action: 'giveUp'; reason: string; failure: SponsorFailure };

export type SponsorClaimResult =
	| { status: 'claimed'; digest: string }
	| { status: 'alreadyClaimed' }
	| { status: 'gaveUp'; reason: string; failure: SponsorFailure };

/** What an attested message mints, net of the fee, or null when there is none that can be read. */
export function netAmountOf(message: string | undefined): bigint | null {
	if (!message) return null;
	try {
		const { amount, feeExecuted } = parseMessageV2(message).body;
		return amount - feeExecuted;
	} catch {
		return null;
	}
}

/** Whether the sponsor takes this net amount. An amount that is not known counts as no. */
export function amountServed(netAmount: bigint | null): boolean {
	return netAmount !== null && netAmount >= MIN_SPONSORED_AMOUNT;
}

/**
 * Whether the sponsor will take a claim on this route, for this net amount. What is not known
 * counts as no: the form then says SUI is needed, and a transfer goes to the wallet as it would
 * with no sponsor.
 */
export function sponsorServes(
	status: SponsorStatus | null,
	source: Pick<ChainDefinition, 'domain'>,
	destination: Pick<ChainDefinition, 'ecosystem'>,
	netAmount: bigint | null,
): boolean {
	if (destination.ecosystem !== 'sui' || !status) return false;
	const { health, deniedDomains } = status;
	return (
		amountServed(netAmount) &&
		health?.ok === true &&
		health.dryRun === false &&
		deniedDomains !== null &&
		!deniedDomains.includes(source.domain)
	);
}

/**
 * What to do with an answer from the claimer or from the platform in front of it. Everything
 * worth another attempt is named here; whatever else comes back goes to the wallet at once, so
 * that a change on the service's side costs one request and not a minute's wait.
 *
 * A browser hides the 429 of a rate limit that carries no CORS headers: `fetch` rejects instead
 * of resolving. So a rejected fetch counts as possibly rate limited.
 */
export function classifySponsorResponse(answer: SponsorAnswer): SponsorVerdict {
	if ('failed' in answer) return { action: 'retry', reason: answer.failed };
	const { status } = answer;
	const body = (answer.body ?? {}) as {
		status?: unknown;
		digest?: unknown;
		reason?: unknown;
		failedDigest?: unknown;
		error?: unknown;
	};
	const said = typeof body.status === 'string' ? body.status : undefined;
	if (status === 200 && said === 'claimed' && typeof body.digest === 'string' && body.digest) {
		return { action: 'claimed', digest: body.digest };
	}
	if (status === 200 && said === 'already_claimed') return { action: 'alreadyClaimed' };
	const named = [`HTTP ${status}`, said, typeof body.reason === 'string' ? body.reason : undefined];
	const reason = named.filter(Boolean).join(' ');
	// A `failedDigest` means it failed on chain, and until the epoch changes every retry signs
	// those same bytes and gets that same result.
	const congested =
		status === 503 &&
		said === 'blocked' &&
		body.reason === 'congested' &&
		body.failedDigest === undefined;
	// The claimer always says `status`. A 5xx without one came from the platform in front of it.
	const platform = status >= 500 && status < 600 && said === undefined;
	if (status === 429 || status === 502 || status === 504 || congested || platform) {
		return { action: 'retry', reason };
	}
	// Refused is final, so only the claimer's own word that it will not take this message counts:
	// `ineligible`, a body it rejected (its 400 says `error`), or a recipient on USDC's deny list.
	// Anything else may pass. A 403 or 404 can come from the platform during a deploy that went
	// wrong, and a claim that failed on chain (`failedDigest`) can go through once the epoch changes.
	const refused =
		(status === 422 && said === 'ineligible') ||
		(status === 400 && said === undefined && typeof body.error === 'string') ||
		(said === 'blocked' && body.reason === 'denied');
	return { action: 'giveUp', reason, failure: refused ? 'refused' : 'unavailable' };
}

/**
 * The wait a `Retry-After` header asks for, in ms, or null when it says nothing usable. Dates are
 * matched by shape first: `Date.parse` makes a date out of nearly anything, "1.5" included.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
	const header = value?.trim();
	if (!header) return null;
	if (/^\d+$/.test(header)) return Number(header) * 1_000;
	if (!/^[A-Za-z].*\d{2}:\d{2}:\d{2}/.test(header)) return null;
	const date = Date.parse(header);
	return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Client for a service that claims attested CCTP V2 messages on Sui with a key of its own and
 * pays the gas. Retrying is safe: a nonce can only be used once, so an attempt that timed out and
 * did land comes back as already claimed. Nothing it says is proof: see where the kit uses it.
 */
export class SponsorClient {
	readonly baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #onStatus?: (status: SponsorStatus) => void;
	readonly #sleep: NonNullable<SponsorClientOptions['sleep']>;
	readonly #now: () => number;
	readonly #random: () => number;
	#status: SponsorStatus | null = null;
	#reading: Promise<SponsorStatus> | undefined;

	constructor(options: SponsorClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, '');
		this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
		this.#onStatus = options.onStatus;
		this.#sleep = options.sleep ?? sleep;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? Math.random;
	}

	/** Whether a source domain is on the denylist as last read. No list yet rules nothing out. */
	denies(domain: number): boolean {
		return this.#status?.deniedDomains?.includes(domain) ?? false;
	}

	/**
	 * The status, read again when what is held has gone stale. Concurrent callers share one read,
	 * and a read that fails is a status too. Rejects only when `signal` aborts.
	 */
	status(signal?: AbortSignal): Promise<SponsorStatus> {
		const held = this.#status;
		if (held && this.#now() - held.checkedAt < STATUS_TTL_MS) {
			return untilAborted(Promise.resolve(held), signal);
		}
		this.#reading ??= this.#readStatus().finally(() => {
			this.#reading = undefined;
		});
		return untilAborted(this.#reading, signal);
	}

	async #readStatus(): Promise<SponsorStatus> {
		const [health, denylist] = await Promise.all([
			this.#getJson('/api/health'),
			this.#getJson('/api/denylist'),
		]);
		const status: SponsorStatus = {
			health: parseHealth(health),
			// The list rarely changes, and without one nothing could be served: a read that fails
			// keeps the one before it.
			deniedDomains: parseDenylist(denylist) ?? this.#status?.deniedDomains ?? null,
			checkedAt: this.#now(),
		};
		this.#status = status;
		this.#onStatus?.(status);
		return status;
	}

	/** No custom headers: a plain GET needs no CORS preflight. */
	async #getJson(path: string): Promise<{ ok: boolean; body: unknown } | null> {
		try {
			return await limited(STATUS_TIMEOUT_MS, undefined, async (signal) => {
				const response = await this.#fetch(`${this.baseUrl}${path}`, { signal });
				return { ok: response.ok, body: await response.json() };
			});
		} catch {
			return null;
		}
	}

	/**
	 * Ask for a message to be claimed, retrying what `classifySponsorResponse` says to retry,
	 * unless `singleAttempt` is set. Resolves with what the service last said. Rejects only when
	 * `signal` aborts.
	 */
	async claim(
		message: string,
		attestation: string,
		signal?: AbortSignal,
		{ singleAttempt = false }: { singleAttempt?: boolean } = {},
	): Promise<SponsorClaimResult> {
		const body = JSON.stringify({ message, attestation });
		const started = this.#now();
		for (let retry = 1; ; retry++) {
			signal?.throwIfAborted();
			const { verdict, retryAfter } = await this.#attempt(body, signal);
			if (verdict.action === 'claimed') return { status: 'claimed', digest: verdict.digest };
			if (verdict.action === 'alreadyClaimed') return { status: 'alreadyClaimed' };
			const { reason } = verdict;
			if (verdict.action === 'giveUp') {
				return { status: 'gaveUp', reason, failure: verdict.failure };
			}
			// From here on it was worth another attempt, whatever stops that attempt being made.
			const unavailable = { status: 'gaveUp', reason, failure: 'unavailable' } as const;
			if (singleAttempt || retry > RETRY_DELAYS_MS.length) return unavailable;
			const asked = parseRetryAfter(retryAfter, this.#now());
			if (asked !== null && asked > MAX_RETRY_AFTER_MS) return unavailable;
			// The jitter only ever adds: a shorter wait could put the last retry back inside the
			// minute the rate limit lasts.
			const delay = asked ?? RETRY_DELAYS_MS[retry - 1]! * (1 + this.#random() / 4);
			// A wait that ends past the limit has no attempt after it, so nobody sits through it.
			if (this.#now() - started + delay >= TOTAL_LIMIT_MS) return unavailable;
			signal?.throwIfAborted();
			await this.#sleep(delay, signal);
			// Timers in a background tab can run a long way past what they were asked for.
			if (this.#now() - started >= TOTAL_LIMIT_MS) return unavailable;
		}
	}

	async #attempt(body: string, signal?: AbortSignal) {
		try {
			const { response, text } = await limited(ATTEMPT_TIMEOUT_MS, signal, async (limit) => {
				const response = await this.#fetch(`${this.baseUrl}/api/claim`, {
					method: 'POST',
					// Text, not JSON, keeps this a CORS simple request: the browser sends no preflight,
					// so one attempt is one request against the rate limit. The claimer reads the body
					// as JSON whatever its content type.
					headers: { 'content-type': 'text/plain;charset=UTF-8' },
					body,
					signal: limit,
				});
				return { response, text: await response.text() };
			});
			return {
				verdict: classifySponsorResponse({ status: response.status, body: parseJson(text) }),
				// Only visible across origins if the server lists it in `Access-Control-Expose-Headers`.
				retryAfter: response.headers.get('retry-after'),
			};
		} catch (error) {
			signal?.throwIfAborted();
			const failed = error === TIMED_OUT ? 'timeout' : 'network';
			return { verdict: classifySponsorResponse({ failed }), retryAfter: null };
		}
	}
}

/**
 * Run a request until it is done, `ms` have passed, or `signal` aborts. The time limit covers
 * reading the body, since a response can stop halfway through. Not `AbortSignal.any`: older Safari
 * does not have it.
 */
async function limited<T>(
	ms: number,
	signal: AbortSignal | undefined,
	request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const limit = new AbortController();
	const stop = () => limit.abort(signal?.reason);
	signal?.addEventListener('abort', stop, { once: true });
	sleep(ms, limit.signal).then(
		() => limit.abort(TIMED_OUT),
		() => undefined,
	);
	try {
		return await untilAborted(request(limit.signal), limit.signal);
	} finally {
		signal?.removeEventListener('abort', stop);
		limit.abort();
	}
}

function parseHealth(answer: { ok: boolean; body: unknown } | null): SponsorStatus['health'] {
	const body = answer?.body as { ok?: unknown; dryRun?: unknown } | null | undefined;
	if (!answer || typeof body?.ok !== 'boolean') return null;
	// A service that does not say it is live is taken not to be.
	return { ok: answer.ok && body.ok, dryRun: body.dryRun !== false };
}

function parseDenylist(answer: { ok: boolean; body: unknown } | null): number[] | null {
	if (!answer?.ok) return null;
	const entries = (answer.body as { sourceDomains?: unknown } | null)?.sourceDomains;
	if (!Array.isArray(entries)) return null;
	const domains = entries.map((entry) => (entry as { domain?: unknown } | null)?.domain);
	return domains.every(Number.isInteger) ? (domains as number[]) : null;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
