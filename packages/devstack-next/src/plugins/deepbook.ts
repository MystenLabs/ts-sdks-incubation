import type { Keypair } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { gitFetch } from '../helpers/git-fetch.js';
import { publishMove } from '../helpers/publish-move.js';
import { pickCreatedByTypeSuffix, publishViaSuiCli } from '../helpers/publish-via-cli.js';
import type { Package } from '../shapes/index.js';
import { sui } from './sui.js';

// Pinned canonical DeepBook v3 ids per network. These come from
// `@mysten/deepbook-v3/utils/constants.ts` — copy them locally so the
// plugin doesn't drag the SDK as a runtime dep just to expose the
// addresses. Bumping the SDK version isn't required to use these IDs;
// the plugin is a static lookup, not a wrapper.
//
// localnet has no canonical deployment — users would `deepbook.publish`
// the source themselves (deferred to a future plugin per STATE.md).
const DEEPBOOK_PACKAGE_IDS = {
	testnet: {
		DEEPBOOK_PACKAGE_ID: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
		REGISTRY_ID: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
		DEEP_TREASURY_ID: '0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb',
		MARGIN_PACKAGE_ID: '0xd6a42f4df4db73d68cbeb52be66698d2fe6a9464f45ad113ca52b0c6ebd918b6',
		MARGIN_REGISTRY_ID: '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75',
		LIQUIDATION_PACKAGE_ID: '0x8d69c3ef3ef580e5bf87b933ce28de19a5d0323588d1a44b9c60b4001741aa24',
	},
	mainnet: {
		DEEPBOOK_PACKAGE_ID: '0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e',
		REGISTRY_ID: '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d',
		DEEP_TREASURY_ID: '0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe',
		MARGIN_PACKAGE_ID: '0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377',
		MARGIN_REGISTRY_ID: '0x0e40998b359a9ccbab22a98ed21bd4346abf19158bc7980c8291908086b3a742',
		LIQUIDATION_PACKAGE_ID: '0x55718c06706bee34c9f3c39f662f10be354a4dcc719699ad72091dc343b641b8',
	},
} as const;

export type DeepbookNetwork = keyof typeof DEEPBOOK_PACKAGE_IDS;

export interface DeepbookOptions {
	/** Override which network's pre-deployed addresses to publish. Defaults
	 * to the engine's `env.network` (when it's testnet or mainnet). Throws
	 * if the resolved network has no canonical DeepBook deployment
	 * (localnet, devnet). */
	network?: DeepbookNetwork;
}

export interface DeepbookState {
	network: DeepbookNetwork;
	packageId: string;
	registryId: string;
	deepTreasuryId: string;
	marginPackageId: string;
	marginRegistryId: string;
	liquidationPackageId: string;
}

const provides = {
	package: dep((s: DeepbookState): Package => ({ name: 'deepbook', packageId: s.packageId })),
	marginPackage: dep(
		(s: DeepbookState): Package => ({ name: 'deepbook-margin', packageId: s.marginPackageId }),
	),
	registryId: dep((s: DeepbookState) => s.registryId),
	deepTreasuryId: dep((s: DeepbookState) => s.deepTreasuryId),
	marginRegistryId: dep((s: DeepbookState) => s.marginRegistryId),
	liquidationPackageId: dep((s: DeepbookState) => s.liquidationPackageId),
	full: dep((s: DeepbookState) => s),
} satisfies Provides<DeepbookState>;

// `deepbook(opts)` — static pre-deployed-addresses producer.
//
// No container, no on-chain calls. Just publishes the canonical DeepBook
// v3 package ids + registry / treasury object ids for the chosen
// network. Consumers (frontend SDK, manifest, bindings) read them via
// `deepbook.get('package')` etc.
//
// Network resolution:
//   - opts.network set → use that.
//   - opts.network unset, env.network is testnet|mainnet → use it.
//   - otherwise → throw at start (localnet/devnet have no canonical IDs).
//
// This is the simplest plugin shape: a plain function returning a single
// `define()`-built producer. No schema split, no dockerContainer, no
// hostProcess.
export function deepbook(opts: DeepbookOptions = {}) {
	return define<DeepbookState, typeof provides>({
		name: 'deepbook',
		provides,
		start: async ({ env }): Promise<DeepbookState> => {
			const network = resolveNetwork(opts.network, env.network);
			const ids = DEEPBOOK_PACKAGE_IDS[network];
			return {
				network,
				packageId: ids.DEEPBOOK_PACKAGE_ID,
				registryId: ids.REGISTRY_ID,
				deepTreasuryId: ids.DEEP_TREASURY_ID,
				marginPackageId: ids.MARGIN_PACKAGE_ID,
				marginRegistryId: ids.MARGIN_REGISTRY_ID,
				liquidationPackageId: ids.LIQUIDATION_PACKAGE_ID,
			};
		},
		represents: {
			packages: (s: DeepbookState): Package[] => [
				{ name: 'deepbook', packageId: s.packageId },
				{ name: 'deepbook-margin', packageId: s.marginPackageId },
			],
		},
	});
}

function resolveNetwork(
	override: DeepbookNetwork | undefined,
	envNetwork: string,
): DeepbookNetwork {
	if (override !== undefined) return override;
	if (envNetwork === 'testnet' || envNetwork === 'mainnet') return envNetwork;
	throw new Error(
		`deepbook: no canonical deployment for network '${envNetwork}'. ` +
			`Pass network: 'testnet' | 'mainnet' explicitly, or run on a network that has one.`,
	);
}

export const DEEPBOOK_DEFAULT_VERSION = 'v7.0.0';
const DEEPBOOK_REPO = 'MystenLabs/deepbookv3';
const DEEPBOOK_SUBDIR = 'packages/deepbook';
const DEEPBOOK_REGISTRY_TYPE_SUFFIX = '::registry::Registry';
const DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX = '::registry::DeepbookAdminCap';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CoinTypeDep = Dep<any, string> | Dep<any, { type: string }>;

export interface DeepbookLocalnetPoolSpec {
	/** Logical pool name (used as the produced state key). */
	name: string;
	/** Base coin Move type. Either a literal `'0x2::sui::SUI'`, a Dep
	 * returning the fully-qualified type string, or a Dep returning a
	 * shape with a `.type` field (the `Coin` shape from
	 * `registerCoin({ name }).get('coin')` works directly). */
	base: string | CoinTypeDep;
	/** Quote coin Move type. Same shape rules as `base`. */
	quote: string | CoinTypeDep;
	tickSize: bigint;
	lotSize: bigint;
	minSize: bigint;
	/** Whitelisted pool — disables DEEP fees. Default true (test-friendly). */
	whitelisted?: boolean;
	/** Stable pool — different fee math. Default false. */
	stable?: boolean;
}

export interface DeepbookLocalnetOptions {
	/** Publisher signer. Typically `accounts.get('signer', { name: 'publisher' })`. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signer: Dep<any, Keypair>;
	/** Pinned deepbookv3 git ref. Default `'v7.0.0'`. The `gitFetch`
	 * cache key includes this, so a bump fetches a fresh tree and the
	 * input hash flips → re-publish. */
	version?: string;
	/** Pools to seed after publish. Empty / omitted skips the pools
	 * step entirely. */
	pools?: ReadonlyArray<DeepbookLocalnetPoolSpec>;
}

export interface DeepbookPoolEntry {
	name: string;
	poolId: string;
	objectType: string;
	baseCoinType: string;
	quoteCoinType: string;
	/** `tickSize` from the pool spec — needed by downstream consumers
	 *  (market makers) to compute level offsets without re-reading the
	 *  spec. Stored as a numeric string since `JSON.stringify` over a
	 *  bigint would throw. */
	tickSize: string;
	lotSize: string;
	minSize: string;
}

export interface DeepbookPoolsState {
	pools: DeepbookPoolEntry[];
}

const poolsProvides = {
	full: dep((s: DeepbookPoolsState) => s),
	pools: dep((s: DeepbookPoolsState) => s.pools),
} satisfies Provides<DeepbookPoolsState>;

// `deepbookLocalnet({ signer, version?, pools? })` — bundle of
// gitFetch + publish + (optional) pool-creation producers for a
// localnet deepbook deploy. Returns:
//   - `source`: gitFetch'd `MystenLabs/deepbookv3` at the pinned tag,
//     subdir `packages/deepbook`. The path Dep is what publish chains.
//   - `publish`: publishMove against the source, capturing the system
//     `Registry` + `DeepbookAdminCap` objects (suffix-matched on the
//     publish tx's object changes) into `PublishedPackage.objects`.
//   - `pools`: present when `pools:` is non-empty. A `define()` step
//     that constructs a single programmable tx invoking
//     `init_balance_manager_map` once + `pool::create_pool_admin`
//     per pool spec, then parses the created Pool object ids out of
//     the tx's object changes.
//
// Localnet-only — no live-net pool creation. Same shape as walrus()
// + sealLocalnet(): a bag of producers the user composes into their
// stack alongside `sui.create({ network: 'localnet' })`.
//
// Composes the existing primitives (`gitFetch`, `publishMove`,
// `publishViaSuiCli`) — no new runners or factories.
export function deepbookLocalnet(opts: DeepbookLocalnetOptions) {
	const version = opts.version ?? DEEPBOOK_DEFAULT_VERSION;
	const poolSpecs = opts.pools ?? [];

	const source = gitFetch({
		name: 'deepbook.source',
		repo: DEEPBOOK_REPO,
		rev: version,
		subdir: DEEPBOOK_SUBDIR,
	});

	const publish = publishMove({
		name: 'deepbook',
		path: source.get('path'),
		signer: opts.signer,
		publish: (ctx) =>
			publishViaSuiCli(ctx, {
				capture: (changes) => {
					const out: Record<string, string> = {};
					const reg = pickCreatedByTypeSuffix(changes, DEEPBOOK_REGISTRY_TYPE_SUFFIX);
					if (reg !== undefined) out.registryId = reg;
					const cap = pickCreatedByTypeSuffix(changes, DEEPBOOK_ADMIN_CAP_TYPE_SUFFIX);
					if (cap !== undefined) out.adminCapId = cap;
					return out;
				},
			}),
	});

	// Per-pool deps map. Stable keys (`pool_<n>_base`/`_quote`) so the
	// resolved deps object the engine hands back has predictable
	// shape. Literal-string specs map to a no-op slot we ignore in
	// `start`.
	const poolDeps: Record<string, Dep<unknown, unknown>> = {};
	poolSpecs.forEach((spec, i) => {
		if (typeof spec.base !== 'string') {
			poolDeps[`pool_${i}_base`] = spec.base as Dep<unknown, unknown>;
		}
		if (typeof spec.quote !== 'string') {
			poolDeps[`pool_${i}_quote`] = spec.quote as Dep<unknown, unknown>;
		}
	});

	const pools =
		poolSpecs.length > 0
			? define<DeepbookPoolsState, typeof poolsProvides>({
					name: 'deepbook.pools',
					runsAs: 'publisher',
					deps: {
						signer: opts.signer,
						rpc: sui.get('rpc'),
						pkg: publish.get('full'),
						...poolDeps,
					},
					provides: poolsProvides,
					inputs: ({ deps }) => {
						const d = deps as Record<string, unknown>;
						return poolSpecs.map((p, i) => ({
							name: p.name,
							base: resolveCoinType(p.base, d[`pool_${i}_base`]),
							quote: resolveCoinType(p.quote, d[`pool_${i}_quote`]),
							tickSize: p.tickSize.toString(),
							lotSize: p.lotSize.toString(),
							minSize: p.minSize.toString(),
							whitelisted: p.whitelisted ?? true,
							stable: p.stable ?? false,
						}));
					},
					start: async ({ deps }): Promise<DeepbookPoolsState> => {
						const d = deps as Record<string, unknown> & {
							signer: Keypair;
							rpc: { url: string };
							pkg: { packageId: string; objects?: Record<string, string> };
						};
						const registryId = d.pkg.objects?.registryId;
						const adminCapId = d.pkg.objects?.adminCapId;
						if (registryId === undefined || adminCapId === undefined) {
							throw new Error(
								'deepbook.pools: registryId / adminCapId missing from publish capture — ' +
									'expected publishMove to surface them via the type-suffix capture',
							);
						}
						// Resolve each pool spec's base/quote against the
						// resolved deps map. Order matches `poolSpecs`.
						const resolved = poolSpecs.map((p, i) => ({
							spec: p,
							base: resolveCoinType(p.base, d[`pool_${i}_base`]),
							quote: resolveCoinType(p.quote, d[`pool_${i}_quote`]),
						}));
						const tx = new Transaction();
						tx.setGasBudget(500_000_000);
						tx.moveCall({
							target: `${d.pkg.packageId}::registry::init_balance_manager_map`,
							arguments: [tx.object(registryId), tx.object(adminCapId)],
						});
						for (const { spec, base, quote } of resolved) {
							tx.moveCall({
								target: `${d.pkg.packageId}::pool::create_pool_admin`,
								typeArguments: [base, quote],
								arguments: [
									tx.object(registryId),
									tx.pure.u64(spec.tickSize),
									tx.pure.u64(spec.lotSize),
									tx.pure.u64(spec.minSize),
									tx.pure.bool(spec.whitelisted ?? true),
									tx.pure.bool(spec.stable ?? false),
									tx.object(adminCapId),
								],
							});
						}
						const client = new SuiJsonRpcClient({ url: d.rpc.url, network: 'localnet' });
						const result = await client.signAndExecuteTransaction({
							signer: d.signer,
							transaction: tx,
							options: { showEffects: true, showObjectChanges: true },
						});
						if (result.effects?.status?.status !== 'success') {
							throw new Error(
								`deepbook.pools: tx failed: ${result.effects?.status?.error ?? 'unknown'}`,
							);
						}
						await client.waitForTransaction({ digest: result.digest });

						const out: DeepbookPoolEntry[] = [];
						const changes = (result.objectChanges ?? []) as SuiObjectChange[];
						for (const { spec, base, quote } of resolved) {
							const expected = `${d.pkg.packageId}::pool::Pool<${base}, ${quote}>`;
							const found = changes.find(
								(c) =>
									c.type === 'created' &&
									'objectType' in c &&
									c.objectType === expected,
							);
							if (found === undefined || found.type !== 'created') {
								throw new Error(`deepbook.pools: created Pool object missing for ${spec.name}`);
							}
							out.push({
								name: spec.name,
								poolId: found.objectId,
								objectType: expected,
								baseCoinType: base,
								quoteCoinType: quote,
								tickSize: spec.tickSize.toString(),
								lotSize: spec.lotSize.toString(),
								minSize: spec.minSize.toString(),
							});
						}
						return { pools: out };
					},
				})
			: undefined;

	return { source, publish, pools };
}

/** Resolve a pool-spec coin type to a literal string. Strings pass
 * through; resolved Dep values (`string` or `{ type }`) project to the
 * type string. Throws on missing/mismatched input. */
function resolveCoinType(
	specEntry: string | CoinTypeDep,
	resolved: unknown,
): string {
	if (typeof specEntry === 'string') return specEntry;
	if (typeof resolved === 'string') return resolved;
	if (
		resolved !== null &&
		typeof resolved === 'object' &&
		'type' in resolved &&
		typeof (resolved as { type: unknown }).type === 'string'
	) {
		return (resolved as { type: string }).type;
	}
	throw new Error(
		`deepbookLocalnet: pool spec base/quote Dep resolved to ${typeof resolved} — expected string or { type: string }`,
	);
}
