// Walrus plugin — Codegenable contribution, via the UNIFIED config-binding
// declaration.
//
// Walrus's contribution is the SDK-ready `packageConfig` shape that the
// `@mysten/walrus` SDK consumes — `{systemObjectId, stakingPoolId,
// exchangeIds}` — plus the proxy / aggregator / publisher / upload-relay URLs
// for HTTP consumers. Walrus is single-instance per stack, so it exports `walrus`
// directly (a FLAT bucket, not name-keyed like coin/seal).
//
// ONE declaration, TWO derivations (see `contracts/config-bindings.ts`):
//   - LIVE (boot): bakes the resolved ids / URLs into the ephemeral tree AND
//     feeds the generic deployment `values` channel.
//   - STATIC (committed tree): emits `requireValue(dep, 'walrus', '<key>')` so the
//     committed `walrus.ts` carries NO baked object id / endpoint URL.
//
// STRUCTURAL fields (`mode`, `network`) stay literals; the on-chain ids,
// coin type, endpoint URLs, and the storage-node committee are RUNTIME
// (loaded config data). The composite `packageConfig` / `nodes` values are
// resolved as whole-value blobs (the array/optional shapes don't split into
// the flat config-path model).

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import {
	configCodegenable,
	type ConfigBinding,
	type ConfigBindingSet,
} from '../../contracts/config-bindings.ts';
import type { JsonValue } from '../../orchestrators/codegen/deployment.ts';

/** Per-node descriptor. */
export interface WalrusNodeBinding {
	readonly nodeIndex: number;
	readonly publicHostname: string;
	readonly rpcUrl: string;
}

/** The typed shape the emitted file exports. */
export interface WalrusBindings {
	readonly mode: 'local' | 'known';
	readonly network: string;
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
	readonly walCoinType: string | null;
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly uploadRelayUrl: string | null;
	readonly nodes: ReadonlyArray<WalrusNodeBinding>;
}

/** Inputs to the LIVE codegen contribution — supplied at acquire-time. */
export interface MakeCodegenableInputs {
	readonly mode: 'local' | 'known';
	readonly network: string;
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
	readonly walCoinType: string | null;
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
	readonly exchangeIds: ReadonlyArray<string>;
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly uploadRelayUrl: string | null;
	readonly nodes: ReadonlyArray<WalrusNodeBinding>;
}

/** User-declared known-deployment ids / URLs, available at factory time. A
 *  KNOWN deployment's values are DECLARED config (not loaded-at-runtime data),
 *  so the committed `walrus.ts` bakes them as LITERALS. Absent for a `local`
 *  (dev-deployed) cluster whose ids/URLs are dynamic. */
export interface WalrusKnownConfig {
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
	readonly walCoinType: string | null;
	readonly packageConfig: WalrusBindings['packageConfig'];
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly uploadRelayUrl: string | null;
	readonly nodes: ReadonlyArray<WalrusNodeBinding>;
}

/** Static-config shape — what walrus knows BEFORE acquire. When `known` is
 *  present (known mode), its declared ids/URLs are baked as literals;
 *  otherwise (local mode) every id/URL resolves at app build/dev time. */
export interface WalrusStaticConfig {
	readonly mode: 'local' | 'known';
	readonly network: string;
	readonly known?: WalrusKnownConfig;
}

const NAMESPACE = 'walrus';

/** TS source-type strings for the resolved walrus fields — keeps the committed
 *  `walrus.ts` typed as `WalrusBindings` declares (the generic `requireValue`
 *  channel would otherwise return `unknown`). Composite blobs inline their
 *  structural literal types so no emitted type-import is needed. */
const PACKAGE_CONFIG_TS_TYPE =
	'{ readonly systemObjectId: string; readonly stakingPoolId: string; readonly exchangeIds?: ReadonlyArray<string> }';
const NODES_TS_TYPE =
	'ReadonlyArray<{ readonly nodeIndex: number; readonly publicHostname: string; readonly rpcUrl: string }>';

/** The walrus config bindings, declared ONCE. `mode` / `network` are
 *  structural literals; every id / coin type / URL / committee value is a
 *  RESOLVED binding on the generic `requireValue(dep, 'walrus', '<key>')` channel.
 *  Both the live boot decl and the static committed-tree decl derive from it. */
const walrusConfigBindings = (
	structural: WalrusStaticConfig,
): ConfigBindingSet<MakeCodegenableInputs> => {
	const known = structural.known;
	// A known deployment's declared ids/URLs are config (literal); a local
	// cluster's are dynamically deployed (resolved at app build/dev time).
	const field = (
		key:
			| 'walrusPackageId'
			| 'walPackageId'
			| 'walCoinType'
			| 'proxyUrl'
			| 'aggregatorUrl'
			| 'publisherUrl'
			| 'uploadRelayUrl',
		live: (i: MakeCodegenableInputs) => JsonValue,
	): ConfigBinding<MakeCodegenableInputs> =>
		known !== undefined
			? { variant: 'literal', configPath: [key], value: known[key] }
			: {
					variant: 'resolved',
					configPath: [key],
					namespace: NAMESPACE,
					key,
					tsType: 'string | null',
					live,
				};
	const packageConfigBinding: ConfigBinding<MakeCodegenableInputs> =
		known !== undefined
			? {
					variant: 'literal',
					configPath: ['packageConfig'],
					value: known.packageConfig as JsonValue,
				}
			: {
					variant: 'resolved',
					configPath: ['packageConfig'],
					namespace: NAMESPACE,
					key: 'packageConfig',
					tsType: PACKAGE_CONFIG_TS_TYPE,
					live: (i) =>
						({
							systemObjectId: i.systemObjectId,
							stakingPoolId: i.stakingPoolId,
							...(i.exchangeIds.length > 0 ? { exchangeIds: [...i.exchangeIds] } : {}),
						}) as JsonValue,
				};
	const nodesBinding: ConfigBinding<MakeCodegenableInputs> =
		known !== undefined
			? { variant: 'literal', configPath: ['nodes'], value: known.nodes as unknown as JsonValue }
			: {
					variant: 'resolved',
					configPath: ['nodes'],
					namespace: NAMESPACE,
					key: 'nodes',
					tsType: NODES_TS_TYPE,
					live: (i) => i.nodes as unknown as JsonValue,
				};
	const bindings: ReadonlyArray<ConfigBinding<MakeCodegenableInputs>> = [
		{ variant: 'literal', configPath: ['mode'], value: structural.mode },
		{ variant: 'literal', configPath: ['network'], value: structural.network },
		field('walrusPackageId', (i) => i.walrusPackageId),
		field('walPackageId', (i) => i.walPackageId),
		field('walCoinType', (i) => i.walCoinType),
		packageConfigBinding,
		field('proxyUrl', (i) => i.proxyUrl),
		field('aggregatorUrl', (i) => i.aggregatorUrl),
		field('publisherUrl', (i) => i.publisherUrl),
		field('uploadRelayUrl', (i) => i.uploadRelayUrl),
		nodesBinding,
	];
	return {
		bucket: 'walrus.ts',
		kind: 'walrus',
		emitterName: 'walrus-network',
		bindings,
	};
};

/** Construct the LIVE Codegenable contribution. Bakes the resolved ids /
 *  URLs into the ephemeral tree + feeds the generic deployment `values`
 *  channel. */
export const makeCodegenable = (inputs: MakeCodegenableInputs): CodegenableDecl =>
	configCodegenable(walrusConfigBindings({ mode: inputs.mode, network: inputs.network }), {
		mode: 'live',
		state: inputs,
	});

/** Construct the STATIC (stack-free) Codegenable contribution. Emits
 *  `requireValue(dep, 'walrus', '<key>')` for the runtime fields; the committed
 *  `walrus.ts` carries no baked object id / endpoint URL. */
export const makeWalrusStaticCodegen = (config: WalrusStaticConfig): CodegenableDecl =>
	configCodegenable(walrusConfigBindings(config), 'static');
