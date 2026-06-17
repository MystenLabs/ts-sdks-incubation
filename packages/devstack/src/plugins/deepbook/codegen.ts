// Deepbook plugin — Codegenable contribution, via the UNIFIED config-binding
// declaration.
//
// ONE declaration, TWO derivations. A deepbook instance declares its
// `deepbook.ts` contribution ONCE as a `ConfigBindingSet` (rooted under its
// instance name). The framework derives both behaviors (see
// `contracts/config-bindings.ts`):
//   - LIVE (boot): bakes the resolved deployment (package / registry / pool
//     ids, pyth feed ids, …) AND feeds the generic id-config `values`
//     channel.
//   - STATIC (committed tree): emits `resolveValue('deepbook:<name>', '<key>')`
//     so the committed `deepbook.ts` carries NO baked on-chain id / URL.
//
// STRUCTURAL fields (`name`, `network`) stay literals. The scalar ids
// (`packageId` / `registryId` / `adminCapId` / `deepTreasuryId`) and the
// composite values (`pools` / `pyth` / `margin` / endpoint URLs) are RUNTIME
// (loaded config data). The composite values carry interleaved structural
// names + runtime ids in array shapes the flat config-path model can't split,
// so each is resolved as ONE whole-value blob through the generic channel.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import {
	keyedBucketSpec,
	liveBucketCodegen,
	staticBucketCodegen,
	type BucketField,
	type SiblingBucketSpec,
} from '../../contracts/config-bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/id-config.ts';

export interface DeepbookBindings {
	readonly name: string;
	readonly network: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly deepTreasuryId: string | null;
	/** Per-pool typed shape (informational only — pools resolve as one blob):
	 *  `{ name, poolId, base, quote, baseCoinType, quoteCoinType }`. */
	readonly pools: ReadonlyArray<{
		readonly name: string;
		readonly poolId: string;
		readonly base: string;
		readonly quote: string;
		readonly baseCoinType: string;
		readonly quoteCoinType: string;
	}>;
	readonly pyth: {
		readonly packageId: string | null;
		readonly stateId: string | null;
		readonly wormholeStateId: string | null;
		readonly feeds: ReadonlyArray<{
			readonly symbol: string;
			readonly feedId: string;
			readonly priceInfoObjectId: string;
			readonly price: string;
			readonly expo: number;
		}>;
	} | null;
	readonly margin: {
		readonly packageId: string;
		readonly registryId: string;
	} | null;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
}

/** User-declared known/override deployment ids, available at factory time. A
 *  KNOWN or OVERRIDE deployment's ids are DECLARED config (not loaded-at-runtime
 *  data), so the committed `deepbook.ts` bakes them as LITERALS. Only the
 *  always-declared scalar ids + the (declared, feed-less) pyth blob are carried;
 *  the dynamically-discovered fields (`adminCapId` for known, `pools`, server
 *  URLs) stay `resolveValue`. */
export interface DeepbookKnownIds {
	readonly packageId: string;
	readonly registryId: string;
	readonly deepTreasuryId?: string | null;
	readonly pyth?: DeepbookBindings['pyth'];
}

/** Static-config shape a deepbook instance can describe BEFORE acquire —
 *  the structural names the stack-free `staticCodegen` hook needs. When
 *  `known` is present (known / override mode), its declared ids are baked as
 *  literals; otherwise (local mode) every id resolves at app build/dev time. */
export interface DeepbookStaticConfig {
	readonly name: string;
	readonly network: string;
	readonly known?: DeepbookKnownIds;
}

type DeepbookLiveState = DeepbookBindings;

/** TS source-type strings for the resolved deepbook fields, so the committed
 *  `deepbook.ts` carries the SAME concrete types `DeepbookBindings` declares
 *  (the generic `resolveValue` channel would otherwise return `unknown`). The
 *  composite blobs (`pools`/`pyth`/`margin`) inline the structural literal
 *  types so no emitted type-import is needed. */
const POOL_TS_TYPE =
	'ReadonlyArray<{ readonly name: string; readonly poolId: string; readonly base: string; readonly quote: string; readonly baseCoinType: string; readonly quoteCoinType: string }>';
const PYTH_TS_TYPE =
	'{ readonly packageId: string | null; readonly stateId: string | null; readonly wormholeStateId: string | null; readonly feeds: ReadonlyArray<{ readonly symbol: string; readonly feedId: string; readonly priceInfoObjectId: string; readonly price: string; readonly expo: number }> } | null';
const MARGIN_TS_TYPE = '{ readonly packageId: string; readonly registryId: string } | null';

/** Build the deepbook instance's config-binding spec for `name`. `name` /
 *  `network` are structural literals; the deployment ids + composite values
 *  are runtime-resolved (`resolveValue`). */
const deepbookBucketSpec = (
	structural: DeepbookStaticConfig,
): SiblingBucketSpec<DeepbookLiveState> => {
	const known = structural.known;
	// A known/override deployment's declared scalar ids are config, baked as
	// literals; a local deployment's ids are dynamic, resolved at build/dev time.
	const idField = (
		key: 'packageId' | 'registryId',
		live: (s: DeepbookLiveState) => JsonValue,
	): BucketField<DeepbookLiveState> =>
		known !== undefined
			? { key, variant: 'literal', value: known[key] }
			: { key, variant: 'resolved', tsType: 'string', live };
	const fields: ReadonlyArray<BucketField<DeepbookLiveState>> = [
		{ key: 'name', variant: 'literal', value: structural.name },
		{ key: 'network', variant: 'literal', value: structural.network },
		idField('packageId', (s) => s.packageId),
		idField('registryId', (s) => s.registryId),
		// `adminCapId` is null for known/override (never declared there) and
		// dynamically captured for local — always resolved.
		{ key: 'adminCapId', variant: 'resolved', tsType: 'string | null', live: (s) => s.adminCapId },
		// `deepTreasuryId` is a declared known-deployment id when present; a
		// dynamic local capture otherwise.
		known !== undefined
			? {
					key: 'deepTreasuryId',
					variant: 'literal',
					value: (known.deepTreasuryId ?? null) as JsonValue,
				}
			: {
					key: 'deepTreasuryId',
					variant: 'resolved',
					tsType: 'string | null',
					live: (s) => s.deepTreasuryId,
				},
		// `pools` is always dynamically discovered (even known/override start
		// empty + may be populated live) — resolved as one whole-value blob.
		{
			key: 'pools',
			variant: 'resolved',
			tsType: POOL_TS_TYPE,
			live: (s) => s.pools as unknown as JsonValue,
		},
		// `pyth` is a DECLARED testnet/mainnet blob for known deployments
		// (literal); a dynamically-deployed mock-Pyth blob for local (resolved).
		known !== undefined
			? { key: 'pyth', variant: 'literal', value: (known.pyth ?? null) as JsonValue }
			: {
					key: 'pyth',
					variant: 'resolved',
					tsType: PYTH_TS_TYPE,
					live: (s) => s.pyth as unknown as JsonValue,
				},
		{
			key: 'margin',
			variant: 'resolved',
			tsType: MARGIN_TS_TYPE,
			live: (s) => s.margin as unknown as JsonValue,
		},
		{ key: 'serverUrl', variant: 'resolved', tsType: 'string | null', live: (s) => s.serverUrl },
		{ key: 'indexerUrl', variant: 'resolved', tsType: 'string | null', live: (s) => s.indexerUrl },
	];
	return keyedBucketSpec({ bucket: 'deepbook.ts', kind: 'deepbook', key: structural.name, fields });
};

/** Build the LIVE Codegenable contribution for a deepbook instance. Bakes
 *  the resolved deployment + feeds the generic id-config `values` channel.
 *  Every instance folds into one `generated/deepbook.ts` exporting
 *  `export const deepbook = { <name>: DeepbookBindings, ... }`. */
export const makeDeepbookCodegenable = (bindings: DeepbookBindings): CodegenableDecl =>
	liveBucketCodegen(
		deepbookBucketSpec({ name: bindings.name, network: bindings.network }),
		bindings,
	);

/** Build the STATIC (stack-free) Codegenable contribution for a deepbook
 *  instance. Emits `resolveValue('deepbook:<name>', '<key>')` for the runtime
 *  fields; the committed `deepbook.ts` carries no baked on-chain id / URL. */
export const makeDeepbookStaticCodegen = (config: DeepbookStaticConfig): CodegenableDecl =>
	staticBucketCodegen(deepbookBucketSpec(config));
