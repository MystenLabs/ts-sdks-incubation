// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Browser-side relay for sui-fork admin RPCs. The devstack wallet-app
// server proxies a curated subset of `ForkControl`'s gRPC surface
// (status read, advance-clock, advance-checkpoint, impersonation slot
// list) over HTTP so the fork panel does not have to ship a gRPC
// client into the browser bundle.
//
// Phase 5 Subtopic 6 (`notes/sui-fork-phase-5.md` §8).
//
// TODO(devstack-side wiring): the matching routes do not yet exist in
// `packages/devstack/src/services/wallet/internal.ts`. The orchestrator
// is expected to land the server side in a follow-up commit;
// `devstack-paths.ts` already enumerates the path contract so the sync
// test (`packages/devstack/src/services/wallet/protocol.test.ts`) will
// fail loudly once the server-side const-object adds the new keys.

import { DEVSTACK_WALLET_HTTP_PATH } from './devstack-paths.js';

/** Snapshot of the fork's current head state.
 *
 * Mirrors the body of `ForkControl.getStatus()` minus the unused
 * heartbeat fields. `clockMs` is a Unix-ms timestamp (the value
 * `clock::timestamp_ms()` returns on chain); `checkpoint` is the
 * latest sealed sequence number.
 */
export interface ForkStatus {
	readonly checkpoint: bigint;
	readonly clockMs: bigint;
	readonly autoTickMs?: number;
	/** Best-effort label of the upstream the fork is pointed at, e.g.
	 *  `'mainnet'` or `'testnet'`. Sourced from the devstack manifest. */
	readonly upstream?: string;
}

/** A single impersonation slot resolved by devstack — typically every
 *  address that was passed to `Sui({fork:{impersonate:[…]}})`. */
export interface ForkImpersonationSlot {
	readonly address: string;
	readonly label?: string;
	/** Whether the wallet currently routes user-driven tx signing through
	 *  the `executeImpersonated` path for this address. The dev-wallet
	 *  server stores the toggle so it persists across page reloads. */
	readonly active: boolean;
}

export interface ForkRelayOptions {
	/** Wallet-app origin (e.g. `http://localhost:9420`). Same value
	 *  `DevstackSignerAdapter` consumes — read from the manifest entry's
	 *  `app.wallet.url`. */
	readonly serverOrigin: string;
	/** Bearer token. Same parsing rules as `DevstackSignerAdapter`. */
	readonly token?: string | null;
}

class ForkRelayHttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'ForkRelayHttpError';
	}
}

/** Tagged result so callers can render an inline error without throwing. */
export type ForkRelayResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string; readonly status?: number };

function isForkStatusBody(
	value: unknown,
): value is { checkpoint: string; clockMs: string; autoTickMs?: number; upstream?: string } {
	if (value === null || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return typeof v.checkpoint === 'string' && typeof v.clockMs === 'string';
}

function isImpersonationsBody(
	value: unknown,
): value is { slots: { address: string; label?: string; active: boolean }[] } {
	if (value === null || typeof value !== 'object') return false;
	const slots = (value as { slots?: unknown }).slots;
	return Array.isArray(slots);
}

/**
 * Thin HTTP client for the fork admin relay. Stateless — each call
 * issues a fresh `fetch`. The UI layer (`dev-wallet-fork-panel`)
 * polls `getStatus` on a low cadence and only refreshes after action
 * verbs land, so the lack of caching here is intentional.
 *
 * @example
 * const relay = new ForkRelay({ serverOrigin, token });
 * const status = await relay.getStatus();
 * if (status.ok) console.log(`clock=${status.value.clockMs}ms`);
 */
export class ForkRelay {
	#serverOrigin: string;
	#authToken: string | null;

	constructor(options: ForkRelayOptions) {
		try {
			new URL(options.serverOrigin);
		} catch {
			throw new Error(`ForkRelay: invalid serverOrigin "${options.serverOrigin}"`);
		}
		this.#serverOrigin = options.serverOrigin;
		this.#authToken = options.token ?? null;
	}

	get serverOrigin(): string {
		return this.#serverOrigin;
	}

	async getStatus(): Promise<ForkRelayResult<ForkStatus>> {
		return this.#request('GET', DEVSTACK_WALLET_HTTP_PATH.FORK_STATUS, undefined, (body) => {
			if (!isForkStatusBody(body)) {
				throw new Error('Malformed fork status response');
			}
			return {
				checkpoint: BigInt(body.checkpoint),
				clockMs: BigInt(body.clockMs),
				autoTickMs: body.autoTickMs,
				upstream: body.upstream,
			};
		});
	}

	async advanceClock(durationMs: number): Promise<ForkRelayResult<ForkStatus>> {
		if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isInteger(durationMs)) {
			return {
				ok: false,
				error: `advanceClock: durationMs must be a positive integer (got ${durationMs})`,
			};
		}
		return this.#request(
			'POST',
			DEVSTACK_WALLET_HTTP_PATH.FORK_ADVANCE_CLOCK,
			{ durationMs },
			(body) => {
				if (!isForkStatusBody(body)) {
					throw new Error('Malformed advance-clock response');
				}
				return {
					checkpoint: BigInt(body.checkpoint),
					clockMs: BigInt(body.clockMs),
					autoTickMs: body.autoTickMs,
					upstream: body.upstream,
				};
			},
		);
	}

	async advanceCheckpoint(count: number): Promise<ForkRelayResult<ForkStatus>> {
		if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
			return {
				ok: false,
				error: `advanceCheckpoint: count must be a positive integer (got ${count})`,
			};
		}
		return this.#request(
			'POST',
			DEVSTACK_WALLET_HTTP_PATH.FORK_ADVANCE_CHECKPOINT,
			{ count },
			(body) => {
				if (!isForkStatusBody(body)) {
					throw new Error('Malformed advance-checkpoint response');
				}
				return {
					checkpoint: BigInt(body.checkpoint),
					clockMs: BigInt(body.clockMs),
					autoTickMs: body.autoTickMs,
					upstream: body.upstream,
				};
			},
		);
	}

	async listImpersonations(): Promise<ForkRelayResult<ForkImpersonationSlot[]>> {
		return this.#request(
			'GET',
			DEVSTACK_WALLET_HTTP_PATH.FORK_IMPERSONATIONS,
			undefined,
			(body) => {
				if (!isImpersonationsBody(body)) {
					throw new Error('Malformed impersonations response');
				}
				return body.slots.map((s) => ({
					address: s.address,
					label: s.label,
					active: s.active,
				}));
			},
		);
	}

	/** Toggle the impersonation slot identified by `address`. The server
	 *  is the source of truth — the response carries the resulting slot
	 *  list so the panel re-renders consistently. */
	async setImpersonation(
		address: string,
		active: boolean,
	): Promise<ForkRelayResult<ForkImpersonationSlot[]>> {
		return this.#request(
			'POST',
			DEVSTACK_WALLET_HTTP_PATH.FORK_IMPERSONATIONS,
			{ address, active },
			(body) => {
				if (!isImpersonationsBody(body)) {
					throw new Error('Malformed impersonations response');
				}
				return body.slots.map((s) => ({
					address: s.address,
					label: s.label,
					active: s.active,
				}));
			},
		);
	}

	async #request<T>(
		method: 'GET' | 'POST',
		path: string,
		body: unknown,
		parse: (raw: unknown) => T,
	): Promise<ForkRelayResult<T>> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.#authToken !== null) {
			headers['Authorization'] = `Bearer ${this.#authToken}`;
		}
		const init: RequestInit = { method, headers };
		if (method === 'POST' && body !== undefined) {
			init.body = JSON.stringify(body);
		}
		let res: Response;
		try {
			res = await fetch(`${this.#serverOrigin}${path}`, init);
		} catch (cause) {
			return {
				ok: false,
				error: `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
			};
		}
		if (!res.ok) {
			const text = await res.text().catch(() => res.statusText);
			return { ok: false, error: text || res.statusText, status: res.status };
		}
		let parsedBody: unknown;
		try {
			parsedBody = await res.json();
		} catch (cause) {
			return {
				ok: false,
				error: `Invalid JSON response: ${cause instanceof Error ? cause.message : String(cause)}`,
				status: res.status,
			};
		}
		try {
			return { ok: true, value: parse(parsedBody) };
		} catch (cause) {
			return {
				ok: false,
				error: cause instanceof Error ? cause.message : String(cause),
				status: res.status,
			};
		}
	}
}

export { ForkRelayHttpError };

/** Narrow input mirroring `DevstackAdapterManifest` — enough to
 *  discover the wallet endpoint + fork-mode flag without pulling in
 *  the full devstack `Manifest` type (no reverse dependency edge,
 *  same reasoning as `devstack-adapter.ts`). */
export interface ForkRelayManifest {
	readonly app?: {
		readonly wallet?: {
			readonly url: string;
			readonly pairUrl?: string;
		};
	};
	readonly meta?: {
		/** Devstack's `meta.runtime` is `'bundled' | 'forked'`. Only
		 *  `'forked'` triggers fork-controls construction. */
		readonly runtime?: string;
		/** Optional upstream label (`'mainnet'`, `'testnet'`, …) used
		 *  by the panel banner. */
		readonly upstream?: string;
	};
}

/** Parse the bearer token off the manifest's `pairUrl`. Duplicates the
 *  logic in `devstack-adapter.ts` rather than importing it because the
 *  fork-relay module must remain dependency-free from the adapter
 *  layer (it's also consumed by codegen-emitted glue that doesn't pull
 *  in the signer adapter bundle). */
function tokenFromPairUrl(pairedUrl: string | undefined): string | null {
	if (pairedUrl === undefined) return null;
	try {
		const url = new URL(pairedUrl);
		if (url.hash.length > 1) {
			const params = new URLSearchParams(url.hash.slice(1));
			const fromHash = params.get('token');
			if (fromHash !== null && fromHash !== '<redacted>') return fromHash;
		}
		const fromQuery = url.searchParams.get('token');
		if (fromQuery !== null && fromQuery !== '<redacted>') return fromQuery;
		return null;
	} catch {
		return null;
	}
}

/**
 * Build a configured {@link ForkRelay} from a devstack manifest, or
 * `null` when fork-mode isn't active (bundled stack, no wallet entry,
 * or the manifest hasn't loaded yet).
 *
 * Codegen-emitted browser glue calls this and forwards the result to
 * `<dev-wallet-panel forkRelay={…}>`.
 */
export function createForkRelayFromManifest(manifest: ForkRelayManifest): ForkRelay | null {
	if (manifest.meta?.runtime !== 'forked') return null;
	const wallet = manifest.app?.wallet;
	if (wallet === undefined) return null;
	try {
		return new ForkRelay({
			serverOrigin: wallet.url,
			token: tokenFromPairUrl(wallet.pairUrl),
		});
	} catch {
		// `new URL(…)` failure surfaces as a thrown Error — swallow it
		// here rather than propagating, the calling app shouldn't
		// blow up just because the manifest's wallet URL is malformed.
		return null;
	}
}
