// Sui plugin — ChainProbe capability implementation.
//
// Architecture §9: ChainProbe is a contract, NOT a primitive. Sui
// provides the only in-tree implementation; the substrate dispatches
// to it via the StrategyContributor registry under
// `chain-probe:<chainId>`.
//
// Lenient mode: returns null for both "not found" AND transient RPC
// failure — verify pipelines re-derive on the next cycle rather than
// fail boot. Strict mode: distinguishes via tagged error.
//
// Why lenient is the default in this plugin's wiring: artifact publisher verify is
// the dominant consumer; artifact publisher's lenient-retry profile (15 attempts,
// 90s budget) is calibrated against lenient semantics. A strict
// surface exists for explicit "I want to know if the chain is
// reachable" callers (the doctor command, debugging).

import { Effect, Schema } from 'effect';
import type { ClientWithCoreApi } from '@mysten/sui/client';

import type {
	ChainProbe,
	ChainProbeError,
	ChainProbeMode,
	ChainProbeSchema,
} from '../../contracts/chain-probe.ts';
import { decodeUnknown } from '../../substrate/runtime/runtime-decode.ts';
import { stringifyCause } from './stringify-cause.ts';

/**
 * Sui's chain-key shape — discriminated so the probe can dispatch
 * between object reads, tx reads, and the (forthcoming) batch
 * variant on one method.
 */
export type SuiProbeKey =
	| { readonly kind: 'object'; readonly objectId: string }
	| { readonly kind: 'transaction'; readonly digest: string };

/** Validated subset of `client.core.getObject(...).object`. We
 *  narrow to the fields verify probes actually consult — the SDK
 *  exposes more (digest, content, json, display) but those are
 *  out of scope here. Variants mirror `SuiClientTypes.ObjectOwner`
 *  from `@mysten/sui/client`. */
const ObjectOwnerSchema = Schema.Union([
	Schema.Struct({
		$kind: Schema.Literal('AddressOwner'),
		AddressOwner: Schema.String,
	}),
	Schema.Struct({
		$kind: Schema.Literal('ObjectOwner'),
		ObjectOwner: Schema.String,
	}),
	Schema.Struct({
		$kind: Schema.Literal('Shared'),
		Shared: Schema.Struct({ initialSharedVersion: Schema.String }),
	}),
	Schema.Struct({
		$kind: Schema.Literal('Immutable'),
		Immutable: Schema.Literal(true),
	}),
	Schema.Struct({
		$kind: Schema.Literal('ConsensusAddressOwner'),
		ConsensusAddressOwner: Schema.Unknown,
	}),
	Schema.Struct({
		$kind: Schema.Literal('Unknown'),
	}),
]);

/** Validated SDK response shape: `{ object: { objectId, type, ... } }`.
 *  Substrate-redesign note: today's code validates `version` as a
 *  string but it's semantically a bigint — branded type recommendation
 *  carried in the Opportunities section. */
export const SuiObjectShapeSchema = Schema.Struct({
	objectId: Schema.String,
	type: Schema.String,
	version: Schema.String,
	owner: ObjectOwnerSchema,
});

export const SuiGetObjectResponseSchema = Schema.Struct({
	object: SuiObjectShapeSchema,
});

/** Plugin-internal SDK shim — the type the plugin's acquire body
 *  hands to the probe factory + the account's sign/execute closure.
 *  Kept narrow so we don't pull `@mysten/sui` types into the substrate.
 *
 *  Exposes the four surfaces consumers actually use:
 *
 *    - `getObject` / `getTransaction` — the lenient chain probe.
 *    - `executeTransaction` — the account plugin's submit path
 *      (txBytes + caller-signed signatures).
 *    - `waitForTransaction` — post-submit finality wait.
 *
 *  Plus an OPAQUE `client` field — the underlying `SuiGrpcClient`
 *  reference. The package plugin's publish-tx builder hands this to
 *  `Transaction.build({ client })` (the SDK resolves gas + object
 *  versions through it). We type as `unknown` so the substrate stays
 *  free of a direct `@mysten/sui/client` type import; the consumer
 *  casts at the boundary (mirrors the same opacity decision in the
 *  Coin plugin's `MintSdkShim.client`). */
export interface SuiSdkShim {
	readonly core: {
		readonly getObject: (args: {
			readonly objectId: string;
			readonly include?: {
				readonly content?: boolean;
				readonly json?: boolean;
			};
		}) => Promise<unknown>;
		readonly getTransaction: (args: { readonly digest: string }) => Promise<unknown>;
		readonly getBalance: (args: {
			readonly owner: string;
			readonly coinType?: string;
		}) => Promise<unknown>;
		readonly listCoins: (args: {
			readonly owner: string;
			readonly coinType?: string;
			readonly limit?: number;
			readonly cursor?: string | null;
		}) => Promise<{
			readonly objects: ReadonlyArray<{
				readonly objectId: string;
				readonly version: string;
				readonly digest: string;
				readonly balance: string;
			}>;
			readonly hasNextPage: boolean;
			readonly cursor: string | null;
		}>;
		readonly executeTransaction: (args: {
			readonly transaction: Uint8Array;
			readonly signatures: ReadonlyArray<string>;
			readonly include?: {
				readonly effects?: boolean;
				readonly objectTypes?: boolean;
			};
		}) => Promise<unknown>;
		readonly waitForTransaction: (args: {
			readonly digest: string;
			readonly timeout?: number;
		}) => Promise<unknown>;
	};
	/** Client reference for `Transaction.build({ client })` and every
	 *  `client.core.*` call. The Sui barrel wires the resolved
	 *  `SuiGrpcClient` through; consumers cast no further. */
	readonly client: ClientWithCoreApi;
}

/** Construct the chain-probe instance for a resolved Sui client +
 *  chain id. The result implements the contract's `ChainProbe<Key>`
 *  shape; the Sui plugin emits this via a StrategyContributorDecl
 *  keyed by `chain-probe:<chainId>`. */
export const makeSuiChainProbe = (sdk: SuiSdkShim, chain: string): ChainProbe<SuiProbeKey> => ({
	get: <Shape>(
		key: SuiProbeKey,
		schema: ChainProbeSchema<Shape>,
		mode: ChainProbeMode,
	): Effect.Effect<Shape | null, ChainProbeError> =>
		Effect.gen(function* () {
			const raw: unknown = yield* Effect.tryPromise({
				try: () =>
					key.kind === 'object'
						? sdk.core.getObject({ objectId: key.objectId })
						: sdk.core.getTransaction({ digest: key.digest }),
				catch: (cause): ChainProbeError => ({
					_tag: 'ChainProbeError',
					reason: isNotFound(cause) ? 'not-found' : 'transient',
					chain,
					detail: stringifyCause(cause),
				}),
			}).pipe(
				// Lenient mode coerces both not-found and transient into a
				// null result. Strict mode lets the error propagate.
				Effect.catch(
					(err): Effect.Effect<unknown, ChainProbeError> =>
						mode === 'lenient' && (err.reason === 'not-found' || err.reason === 'transient')
							? Effect.succeed(null)
							: Effect.fail(err),
				),
			);
			if (raw === null) return null;
			const payload = projectProbePayload(key, raw);
			if (payload === null) return null;

			// Decode against the caller-supplied Schema. A decode failure
			// is structured (NOT silent undefined) — this is the
			// load-bearing learning from deepbook.
			const decoded = yield* decodeUnknown(schema, payload, {
				source: `chain probe ${chain}`,
				mkError: (issue): ChainProbeError => ({
					_tag: 'ChainProbeError',
					reason: 'decode-failed',
					chain,
					detail: stringifyCause(issue.cause ?? issue),
				}),
			});
			return decoded;
		}),
});

const projectProbePayload = (key: SuiProbeKey, raw: unknown): unknown | null => {
	if (key.kind === 'transaction') return projectTransactionPayload(raw);
	if (typeof raw !== 'object' || raw === null || !('object' in raw)) return raw;

	return (raw as { readonly object?: unknown }).object ?? null;
};

const projectTransactionPayload = (raw: unknown): unknown | null => {
	if (typeof raw !== 'object' || raw === null) return raw;
	const envelope = raw as {
		readonly $kind?: 'Transaction' | 'FailedTransaction';
		readonly Transaction?: unknown;
		readonly FailedTransaction?: unknown;
	};
	if (envelope.$kind === 'Transaction') return envelope.Transaction ?? null;
	if (envelope.$kind === 'FailedTransaction') return envelope.FailedTransaction ?? null;
	return raw;
};

/** Heuristic: SDK errors carrying "not found" / "Not exist" in
 *  the message are treated as not-found; everything else is
 *  transient. The substrate's lenient-retry profile re-runs the
 *  probe on a transient bucket; not-found is terminal. */
const isNotFound = (cause: unknown): boolean => {
	const msg = (cause as { message?: string })?.message?.toLowerCase() ?? '';
	return (
		msg.includes('not found') ||
		msg.includes('does not exist') ||
		msg.includes('no such object') ||
		msg.includes('not exist')
	);
};
