// Fork-mode orchestration helpers.
//
// Owns the runtime SDK guard for surfaces the sui-fork binary panics
// on. The data-dir lock + seed-manifest meta gate live in the
// fork-mode builder once that wiring lands; they belong to the same
// file once they have real implementations to anchor on.

import { forkUnsupportedError, type ForkUnsupportedError } from './errors.ts';

/** Lock-holder identity persisted alongside the data-dir lock file.
 *  Two fork acquires against the same data dir surface this; one
 *  wins, the other gets an actionable error. */
export interface ForkLockHolder {
	readonly pid: number;
	readonly host: string;
	readonly instanceId: string;
	readonly startedAt: number;
}

/** On-disk seed-manifest snapshot. */
export interface ForkMeta {
	readonly version: number;
	readonly createdAt: number;
	readonly upstream: string;
	readonly checkpoint?: string;
	/** Lowercased + sorted (architecture invariant: configHash MUST
	 *  be stable across orderings). */
	readonly seedAddresses: ReadonlyArray<string>;
	/** Lowercased + sorted, same invariant. */
	readonly seedObjects: ReadonlyArray<string>;
	/** Digest of the above four fields. `autoTickMs` is NOT folded
	 *  in (architecture invariant). */
	readonly configHash: string;
	readonly runtime?: { readonly autoTickMs?: number };
}

/** Surfaces that the sui-fork binary explicitly panics on. New
 *  upstream additions fail OPEN by default — architecture
 *  invariant. */
export const FORK_UNSUPPORTED_SURFACES: ReadonlyArray<string> = [
	// `client.core.*` methods that hit `simulate_transaction` /
	// balance-derivation paths the fork binary doesn't implement.
	'getBalance',
	'listBalances',
	'getCoinInfo',
] as const;

/** Wrap a Sui SDK shim with the fork guard. Property access for a
 *  blocklisted surface SYNCHRONOUSLY throws — the wire call never
 *  happens, so the fork binary stays up. */
export const wrapWithForkGuard = <Sdk extends { readonly core: object }>(sdk: Sdk): Sdk => {
	const guardedCore = new Proxy(sdk.core as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && FORK_UNSUPPORTED_SURFACES.includes(prop)) {
				const err: ForkUnsupportedError = forkUnsupportedError(
					`client.core.${prop}`,
					'fork mode does not implement this SDK surface — use the impersonation helper ' +
						'or read state via ChainProbe.',
				);
				throw err;
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as Sdk['core'];
	// Preserve all SDK fields (e.g. SuiSdkShim's opaque `client` for
	// Transaction.build) — only the `core` proxy intercepts; siblings
	// like `client` flow through unchanged.
	return { ...sdk, core: guardedCore };
};
