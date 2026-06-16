// Deepbook plugin — barrel + factories.
//
// Architecture: Deepbook is a task plugin that resolves a managed
// local deployment, a known deployment, or explicit caller-supplied
// override ids, then emits bindings.
//
// Mode discipline:
//
//   - `deepbook(opts)`             — explicit mode selection.
//                                     Localnet can default to local when
//                                     passed local options.
//   - `deepbookFor(network).local` — local-branch managed deployment.
//   - `deepbookFor(network).override` — local-branch override for
//                                     caller-supplied deployment ids.
//   - `deepbookFor(network).known` — known-deployment branch (live +
//                                     fork networks; wraps an already-
//                                     deployed canonical instance).
//
// During `start`, the plugin emits (via the typed `ctx.*` verbs):
//
//   Local mode:
//     1. `ctx.snapshotExtra` — `deepbook/<name>` subtree.
//     2. `ctx.codegen`       — `deepbook-network` bindings.
//
//   Override mode:
//     1. `ctx.snapshotExtra` — identity guard only.
//     2. `ctx.codegen`       — `deepbook-network` bindings.
//
//   Known mode:
//     1. `ctx.snapshotExtra` — identity guard only.
//     2. `ctx.codegen`       — `deepbook-network` bindings (mode='known').
//
// Resource id: `deepbook/<name>`. Plugin key: `deepbook:<name>`.

import { Effect } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource, type ResourceValueOf } from '../../api/define-plugin.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import { PluginContext } from '../../substrate/plugin-ctx.ts';
import { CacheService } from '../../substrate/runtime/cache/index.ts';
import { setCurrentPluginPhase } from '../../substrate/runtime/current-plugin.ts';
import { passthroughOrWrap } from '../../substrate/runtime/passthrough-or-wrap.ts';
import { IdentityContext } from '../../substrate/runtime/paths.ts';
import { suiResource } from '../sui/index.ts';
import type { AccountValue } from '../account/index.ts';
import type { CoinValue } from '../coin/index.ts';
import type { LocalPackageResolved } from '../package/index.ts';

import { deepbookPluginKey } from './plugin-key.ts';
import {
	DEEPBOOK_ERROR_TAGS,
	deepbookConfigError,
	deepbookPluginError,
	type DeepbookConfigError,
	type DeepbookError,
	type DeepbookPluginError,
} from './errors.ts';
import { makeDeepbookCodegenable, type DeepbookBindings } from './codegen.ts';
import {
	makeDeepbookDeepFundingContribution,
	makeDeepbookDeepFundingStrategy,
	type DeepbookDeepFundingStrategy,
} from './faucet-strategy.ts';
import { makeKnownSnapshotable, makeLocalSnapshotable } from './snapshot.ts';
import {
	createDeepbookPools,
	seedDeepbookPools,
	type DeepbookDeployment,
	type ResolvedDeepbookPoolSpec,
} from './deploy.ts';
import { initLocalPythFeeds } from './pyth/index.ts';
import type {
	AccountMemberAlias,
	DeepbookPackageMember,
	DeepbookPool,
	DeepbookPoolSpec,
	PythHandle,
	PythOptions,
} from './types.ts';

// ---------------------------------------------------------------------------
// Resource — the resolved value all consumers read
// ---------------------------------------------------------------------------

export type DeepbookResourceId<Name extends string> = `deepbook/${Name}`;

const makeDeepbookResource = <Name extends string>(name: Name) =>
	resource<DeepbookResourceId<Name>, DeepbookResolved>(
		`deepbook/${name}` as DeepbookResourceId<Name>,
	);

/** The deepbook resolved value. Mode-asymmetric:
 *
 *   - `adminCapId` is `null` for known-deployment mode.
 *   - `margin` / `serverUrl` / `indexerUrl` / `marketMakerRunning`
 *     are `null` when the corresponding sub-feature is not enabled. */
export interface DeepbookResolved {
	readonly mode: 'local' | 'override' | 'known';
	readonly network: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly deepTreasuryId: string | null;
	readonly pools: ReadonlyArray<DeepbookPool>;
	readonly pyth: PythHandle | null;
	readonly margin: {
		readonly packageId: string;
		readonly registryId: string;
	} | null;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
	readonly marketMakerRunning: boolean;
	readonly deepFundingStrategy: DeepbookDeepFundingStrategy | null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepbookCommonOptions {
	readonly name?: string;
}

/** Override mode wraps an explicitly supplied deployment. It does not
 *  publish or manage DeepBook locally. */
export interface DeepbookOverrideOptions extends DeepbookCommonOptions {
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string;
	readonly network?: string;
}

/** Local mode wraps an explicitly supplied local DeepBook package.
 *
 *  Explicit-config discipline: `publisher`, `package`, and `pools` are all
 *  REQUIRED — the caller publishes the DeepBook Move tree, funds a publisher,
 *  and declares the pools. There is no zero-arg auto-synthesis; an
 *  under-specified `deepbook({ mode: 'local' })` fails fast with a tagged
 *  config error (see the guard in `resolveLocalOptions`). `pyth` stays
 *  optional — pass it to seed local mock price feeds, omit it for a
 *  feed-less DeX. */
export interface DeepbookLocalOptions<
	Publisher extends AccountMemberAlias = AccountMemberAlias,
	Package extends DeepbookPackageMember = DeepbookPackageMember,
	Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
	Pyth extends PythOptions | undefined = undefined,
> extends DeepbookCommonOptions {
	/** Publisher account — Direct Member Ref (locked API decision). Required. */
	readonly publisher: Publisher;
	/** Published DeepBook package member. The package must capture the
	 *  `registry::Registry` and `registry::DeepbookAdminCap` object ids.
	 *  Required. */
	readonly package: Package;
	/** Optional local mock-Pyth package + feed setup. Omit for a feed-less
	 *  local DeX. */
	readonly pyth?: Pyth;
	/** Capture key for the package-created `registry::Registry`. */
	readonly registryIdKey?: string;
	/** Capture key for the package-created `registry::DeepbookAdminCap`. */
	readonly adminCapIdKey?: string;
	/** Optional capture key for a DEEP treasury object used by SDK bindings. */
	readonly deepTreasuryIdKey?: string;
	/** Pools to create after the DeepBook package publishes. Required; pass
	 *  `[]` explicitly for composition tests or a known-empty deployment. */
	readonly pools: Pools;
}

export type DeepbookKnownNetwork = 'mainnet' | 'testnet';

interface DeepbookKnownCommonOptions extends DeepbookCommonOptions {
	/** Optional network override (defaults to the configured network). */
	readonly network?: string;
}

interface DeepbookKnownNetworkOptions extends DeepbookKnownCommonOptions {
	readonly network: DeepbookKnownNetwork;
	readonly packageId?: string;
	readonly registryId?: string;
}

interface DeepbookKnownExplicitOptions extends DeepbookKnownCommonOptions {
	readonly packageId: string;
	readonly registryId: string;
	readonly network?: DeepbookKnownNetwork;
}

export type DeepbookKnownOptions = DeepbookKnownNetworkOptions | DeepbookKnownExplicitOptions;

export type DeepbookOptions<
	Publisher extends AccountMemberAlias = AccountMemberAlias,
	Pyth extends PythOptions | undefined = PythOptions | undefined,
> =
	| ({
			readonly mode: 'local';
	  } & DeepbookLocalOptions<
			Publisher,
			DeepbookPackageMember,
			ReadonlyArray<DeepbookPoolSpec>,
			Pyth
	  >)
	| ({ readonly mode: 'override' } & DeepbookOverrideOptions)
	| ({ readonly mode: 'known' } & DeepbookKnownOptions);

// ---------------------------------------------------------------------------
// Plugin construction — override
// ---------------------------------------------------------------------------

const DEFAULT_NAME = 'deepbook';

const KNOWN_DEEPBOOK_DEPLOYMENTS: Record<
	DeepbookKnownNetwork,
	{
		readonly network: string;
		readonly packageId: string;
		readonly registryId: string;
		readonly deepTreasuryId: string;
		readonly pyth: PythHandle;
	}
> = {
	testnet: {
		network: 'testnet',
		packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
		registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
		deepTreasuryId: '0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb',
		pyth: {
			packageId: null,
			stateId: '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
			wormholeStateId: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
			feeds: [],
		},
	},
	mainnet: {
		network: 'mainnet',
		packageId: '0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e',
		registryId: '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d',
		deepTreasuryId: '0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe',
		pyth: {
			packageId: null,
			stateId: '0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8',
			wormholeStateId: '0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c',
			feeds: [],
		},
	},
};

type PoolCoinRefs<Pools extends ReadonlyArray<DeepbookPoolSpec>> =
	Pools[number] extends DeepbookPoolSpec<infer Base, infer Quote> ? Base | Quote : never;
type PoolCoinRefTuple<Pools extends ReadonlyArray<DeepbookPoolSpec>> = Pools extends readonly []
	? readonly []
	: readonly PoolCoinRefs<Pools>[];

type PythRefs<Pyth extends PythOptions | undefined> =
	Pyth extends PythOptions<infer Package, infer Pusher> ? readonly [Pusher, Package] : readonly [];

type LocalDependsOn<
	Publisher extends AccountMemberAlias,
	Package extends DeepbookPackageMember,
	Pools extends ReadonlyArray<DeepbookPoolSpec>,
	Pyth extends PythOptions | undefined,
> = readonly [
	typeof suiResource,
	Publisher,
	Package,
	...PythRefs<Pyth>,
	...PoolCoinRefTuple<Pools>,
];

const poolCoinRefs = <Pools extends ReadonlyArray<DeepbookPoolSpec>>(
	pools: Pools,
): ReadonlyArray<PoolCoinRefs<Pools>> =>
	pools.flatMap((pool) => [pool.base.coin, pool.quote.coin]) as unknown as ReadonlyArray<
		PoolCoinRefs<Pools>
	>;

const pythRefs = <Pyth extends PythOptions | undefined>(pyth: Pyth): PythRefs<Pyth> =>
	(pyth === undefined ? [] : [pyth.pusher, pyth.package]) as unknown as PythRefs<Pyth>;

const localDependsOn = <
	Publisher extends AccountMemberAlias,
	Package extends DeepbookPackageMember,
	Pools extends ReadonlyArray<DeepbookPoolSpec>,
	Pyth extends PythOptions | undefined,
>(
	opts: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
): LocalDependsOn<Publisher, Package, Pools, Pyth> =>
	[
		suiResource,
		opts.publisher,
		opts.package,
		...pythRefs(opts.pyth),
		...poolCoinRefs((opts.pools ?? []) as Pools),
	] as unknown as LocalDependsOn<Publisher, Package, Pools, Pyth>;

const requireCapturedId = (
	pkg: LocalPackageResolved,
	key: string,
	kind: 'registryId' | 'adminCapId',
): Effect.Effect<string, DeepbookPluginError> => {
	const value = pkg.captured[key];
	if (typeof value === 'string' && value.length > 0) {
		return Effect.succeed(value);
	}
	return Effect.fail(
		deepbookPluginError(
			'publish',
			`deepbook local package '${pkg.name}' is missing captured ${kind} '${key}'.`,
		),
	);
};

const requirePoolCoinValue = (
	coinValuesByRefId: ReadonlyMap<string, CoinValue>,
	poolName: string,
	side: 'base' | 'quote',
	coinRefId: string,
): Effect.Effect<CoinValue, DeepbookConfigError> => {
	const value = coinValuesByRefId.get(coinRefId);
	if (value === undefined) {
		// Compose-time bug — `dependsOn`/`poolCoinRefs` dropped this coin.
		// Surface a typed config error naming the missing coin id rather
		// than letting a double-cast `undefined` slip into the resolved
		// pool spec. Lands on the typed E channel (not a sync throw, which
		// inside Effect.gen would become an uncaught DEFECT that
		// `passthroughOrWrap` could not see); `DeepbookConfigError` is in
		// `DEEPBOOK_ERROR_TAGS`, so the outer pipeline passes it through
		// untouched.
		return Effect.fail(
			deepbookConfigError(
				'pools',
				`deepbook: pool '${poolName}' ${side} coin '${coinRefId}' was not resolved by the dependency tuple.`,
				'This is a compose-time bug — ensure the coin member is included in `dependsOn`/`poolCoinRefs`.',
			),
		);
	}
	return Effect.succeed(value);
};

const resolvePoolSpecs = (
	pools: ReadonlyArray<DeepbookPoolSpec>,
	coinValuesByRefId: ReadonlyMap<string, CoinValue>,
): Effect.Effect<ReadonlyArray<ResolvedDeepbookPoolSpec>, DeepbookConfigError> =>
	Effect.forEach(pools, (pool) =>
		Effect.gen(function* () {
			const base = yield* requirePoolCoinValue(
				coinValuesByRefId,
				pool.name,
				'base',
				pool.base.coin.id,
			);
			const quote = yield* requirePoolCoinValue(
				coinValuesByRefId,
				pool.name,
				'quote',
				pool.quote.coin.id,
			);
			return {
				name: pool.name,
				base: pool.base.key,
				quote: pool.quote.key,
				baseCoinType: base.fullCoinType,
				quoteCoinType: quote.fullCoinType,
				...(base.fundingStrategy === undefined
					? {}
					: { baseFundingStrategy: base.fundingStrategy }),
				...(quote.fundingStrategy === undefined
					? {}
					: { quoteFundingStrategy: quote.fundingStrategy }),
				tickSize: pool.tickSize,
				lotSize: pool.lotSize,
				minSize: pool.minSize,
				whitelisted: pool.whitelisted ?? true,
				stablePool: pool.stablePool ?? false,
				...(pool.seed === undefined ? {} : { seed: pool.seed }),
			};
		}),
	);

const assertUniquePoolNames = (name: string, pools: ReadonlyArray<DeepbookPoolSpec>) => {
	const seen = new Set<string>();
	for (const pool of pools) {
		if (seen.has(pool.name)) {
			throw deepbookConfigError(
				'pools',
				`deepbook({mode:'local', name:'${name}'}) has duplicate pool '${pool.name}'.`,
				'Give each local DeepBook pool a unique SDK key.',
			);
		}
		seen.add(pool.name);
		for (const order of pool.seed?.orders ?? []) {
			if (order.quantity < pool.minSize) {
				throw deepbookConfigError(
					'pools',
					`deepbook({mode:'local', name:'${name}'}) seed order for pool '${pool.name}' is below minSize.`,
					'Use a seed order quantity greater than or equal to the pool minSize.',
				);
			}
			if (order.quantity % pool.lotSize !== 0n) {
				throw deepbookConfigError(
					'pools',
					`deepbook({mode:'local', name:'${name}'}) seed order for pool '${pool.name}' is not lot-aligned.`,
					'Use a seed order quantity divisible by the pool lotSize.',
				);
			}
			if (order.price % pool.tickSize !== 0n) {
				throw deepbookConfigError(
					'pools',
					`deepbook({mode:'local', name:'${name}'}) seed order for pool '${pool.name}' is not tick-aligned.`,
					'Use a seed order price divisible by the pool tickSize.',
				);
			}
		}
	}
};

const buildOverridePlugin = (opts: DeepbookOverrideOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	if (!opts.packageId || !opts.registryId || !opts.adminCapId) {
		throw deepbookConfigError(
			'packageId',
			`deepbook({mode:'override', name:'${name}'}) requires packageId, registryId, and adminCapId.`,
			`Pass explicit deployment ids or use deepbook({mode:'known', network:'testnet'}).`,
		);
	}
	const deepbookResource = makeDeepbookResource(name);
	const snap = makeKnownSnapshotable({ name });

	return definePlugin({
		id: deepbookResource.id,
		dependsOn: [suiResource] as const,
		role: 'task',
		section: 'service',
		pluginKey: deepbookPluginKey(name),
		// `deps` auto-infers the resolved `[sui]` tuple from the
		// `[suiResource] as const` dependency. `ctx` arrives via the
		// `PluginContext` service.
		start: () =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const identity = yield* IdentityContext;
				const network = opts.network ?? identity.network;
				const resolved: DeepbookResolved = {
					mode: 'override',
					network,
					packageId: opts.packageId,
					registryId: opts.registryId,
					adminCapId: opts.adminCapId,
					deepTreasuryId: null,
					pools: [],
					pyth: null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: false,
					deepFundingStrategy: null,
				};
				// Emit contributions inline: snapshot -> codegen. `resolved` is
				// the just-computed value; `snap` is the override-mode
				// identity-guard snapshotable in scope. No DEEP funding.
				const bindings: DeepbookBindings = {
					name,
					network: resolved.network,
					packageId: resolved.packageId,
					registryId: resolved.registryId,
					adminCapId: resolved.adminCapId,
					deepTreasuryId: resolved.deepTreasuryId,
					pools: [],
					pyth: null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
				};
				ctx.snapshotExtra(snap);
				ctx.codegen(makeDeepbookCodegenable(bindings));
				return resolved;
			}),
	});
};

/** Concrete local options after the explicit-config guard: `publisher`,
 *  `package`, and `pools` are guaranteed present. */
type ResolvedLocalOptions = DeepbookLocalOptions<
	AccountMemberAlias,
	DeepbookPackageMember,
	ReadonlyArray<DeepbookPoolSpec>,
	PythOptions | undefined
> & {
	readonly publisher: AccountMemberAlias;
	readonly package: DeepbookPackageMember;
	readonly pools: ReadonlyArray<DeepbookPoolSpec>;
};

/** Fail-fast guard for local mode: `publisher`, `package`, and `pools` are
 *  REQUIRED. A bare `deepbook()` / `deepbook({ mode: 'local' })` no longer
 *  auto-synthesizes a DeX from the bundled Move sources — the caller must
 *  publish the DeepBook package, fund a publisher, and declare the pools
 *  explicitly (see `examples/deepbook-trader`). Missing any of these raises a
 *  tagged `DeepbookConfigError` naming what to pass. `pyth` stays optional. */
const resolveLocalOptions = (
	opts: DeepbookLocalOptions<
		AccountMemberAlias,
		DeepbookPackageMember,
		ReadonlyArray<DeepbookPoolSpec>,
		PythOptions | undefined
	>,
): ResolvedLocalOptions => {
	const name = opts.name ?? DEFAULT_NAME;
	const missing: string[] = [];
	if (!opts.publisher) {
		missing.push('publisher');
	}
	if (!opts.package) {
		missing.push('package');
	}
	if (opts.pools === undefined) {
		missing.push('pools');
	}
	if (missing.length > 0) {
		throw deepbookConfigError(
			missing[0] as string,
			`deepbook({mode:'local', name:'${name}'}) requires explicit ${missing.join(', ')}.`,
			`Publish the DeepBook Move package and pass { publisher, package, pools } ` +
				`(see examples/deepbook-trader). Local DeepBook is no longer auto-synthesized.`,
		);
	}
	return opts as ResolvedLocalOptions;
};

const buildLocalPlugin = <
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
	const Pyth extends PythOptions | undefined = undefined,
>(
	rawOpts: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
) => {
	const opts = resolveLocalOptions(
		rawOpts as DeepbookLocalOptions<
			AccountMemberAlias,
			DeepbookPackageMember,
			ReadonlyArray<DeepbookPoolSpec>,
			PythOptions | undefined
		>,
	);
	const name = opts.name ?? DEFAULT_NAME;
	assertUniquePoolNames(name, opts.pools);

	const deepbookResource = makeDeepbookResource(name);
	// Runtime `dependsOn` carries the caller's explicit member refs so
	// `defineDevstack`'s dependency-closure expander pulls the publisher /
	// package / coin / pyth members into the stack. The STATIC type stays keyed
	// to the caller's narrow generics so explicit callers keep their exact
	// closure (no generic `coin:`/`package:` provider demands).
	const dependsOn = localDependsOn(opts) as unknown as LocalDependsOn<
		Publisher,
		Package,
		Pools,
		Pyth
	>;

	return definePlugin({
		id: deepbookResource.id,
		dependsOn,
		role: 'task',
		section: 'service',
		pluginKey: deepbookPluginKey(name),
		// `deps` auto-infers from the runtime-built `dependsOn`; it
		// resolves to a heterogeneous tuple the body re-narrows via the
		// `as unknown as` cast below. `ctx` arrives via the
		// `PluginContext` service.
		start: (deps) =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const identity = yield* IdentityContext;
				const [sui, publisher, deepbookPackage, ...extraValues] = deps as unknown as readonly [
					ResourceValueOf<typeof suiResource>,
					AccountValue,
					LocalPackageResolved,
					...(AccountValue | LocalPackageResolved | CoinValue)[],
				];
				const pythValueCount = opts.pyth === undefined ? 0 : 2;
				const pythValues = extraValues.slice(0, pythValueCount);
				const coinValues = extraValues.slice(pythValueCount) as CoinValue[];

				yield* setCurrentPluginPhase('reading deployment captures');

				const registryId = yield* requireCapturedId(
					deepbookPackage,
					opts.registryIdKey ?? 'registryId',
					'registryId',
				);
				const adminCapId = yield* requireCapturedId(
					deepbookPackage,
					opts.adminCapIdKey ?? 'adminCapId',
					'adminCapId',
				);
				const deepTreasuryId =
					opts.deepTreasuryIdKey === undefined
						? null
						: (deepbookPackage.captured[opts.deepTreasuryIdKey] ?? null);
				const deployment: DeepbookDeployment = {
					packageId: deepbookPackage.packageId,
					registryId,
					adminCapId,
					deepTreasuryId,
				};
				const poolRefs = poolCoinRefs(opts.pools);
				const coinValuesByRefId = new Map<string, CoinValue>();
				for (let i = 0; i < poolRefs.length; i += 1) {
					const ref = poolRefs[i];
					const value = coinValues[i];
					if (ref !== undefined && value !== undefined) {
						coinValuesByRefId.set(ref.id, value);
					}
				}
				const poolSpecs = yield* resolvePoolSpecs(opts.pools, coinValuesByRefId);
				const artifactPublisher = yield* CacheService;
				yield* setCurrentPluginPhase(
					opts.pyth === undefined ? 'creating pools' : 'initializing Pyth feeds',
				);
				const pyth =
					opts.pyth === undefined
						? null
						: yield* initLocalPythFeeds(
								artifactPublisher,
								sui.sdk,
								sui.chainId,
								pythValues[0] as AccountValue,
								{ packageId: (pythValues[1] as LocalPackageResolved).packageId },
								opts.pyth.feeds,
							);
				yield* setCurrentPluginPhase('creating pools');
				const poolResult = yield* createDeepbookPools(
					artifactPublisher,
					sui.sdk,
					sui.chainId,
					publisher,
					deployment,
					poolSpecs,
				);
				yield* setCurrentPluginPhase('seeding pools');
				const seedResults = yield* seedDeepbookPools(
					artifactPublisher,
					sui.sdk,
					sui.chainId,
					publisher,
					deployment,
					poolSpecs,
					poolResult.pools,
				);
				yield* setCurrentPluginPhase(null);

				const resolved: DeepbookResolved = {
					mode: 'local',
					network: identity.network,
					packageId: deployment.packageId,
					registryId: deployment.registryId,
					adminCapId: deployment.adminCapId,
					deepTreasuryId,
					pools: poolResult.pools,
					pyth,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: seedResults.length > 0,
					deepFundingStrategy: null,
				};
				// Emit contributions inline: snapshot -> codegen. `resolved` is
				// the just-computed value; the snapshotable is the local-mode
				// `deepbook/<name>` subtree. No DEEP funding (null in local).
				const snap: SnapshotableDecl = makeLocalSnapshotable({ name });
				const bindings: DeepbookBindings = {
					name,
					network: resolved.network,
					packageId: resolved.packageId,
					registryId: resolved.registryId,
					adminCapId: resolved.adminCapId,
					deepTreasuryId: resolved.deepTreasuryId,
					pools: resolved.pools.map((p) => ({
						name: p.name,
						poolId: p.poolId,
						base: p.base,
						quote: p.quote,
						baseCoinType: p.baseCoinType,
						quoteCoinType: p.quoteCoinType,
					})),
					pyth: resolved.pyth
						? {
								packageId: resolved.pyth.packageId,
								stateId: resolved.pyth.stateId,
								wormholeStateId: resolved.pyth.wormholeStateId,
								feeds: resolved.pyth.feeds.map((feed) => ({
									symbol: feed.symbol,
									feedId: feed.feedId,
									priceInfoObjectId: feed.priceInfoObjectId,
									price: feed.price.toString(),
									expo: feed.expo,
								})),
							}
						: null,
					margin: resolved.margin,
					serverUrl: resolved.serverUrl,
					indexerUrl: resolved.indexerUrl,
				};
				ctx.snapshotExtra(snap);
				ctx.codegen(makeDeepbookCodegenable(bindings));
				return resolved;
			}).pipe(
				// The body's aggregate E channel includes substrate Effects
				// whose error shape is unknown to TS (ArtifactPublisher
				// produce bodies, dependency reads). `Effect.catchTags`
				// would need a statically-known tagged union; the
				// substrate's `passthroughOrWrap` runtime-checks the `_tag`
				// against `DEEPBOOK_ERROR_TAGS`, passing typed deepbook
				// errors through untouched and wrapping everything else
				// under `'publish'` so cascade attribution stays with the
				// plugin.
				passthroughOrWrap.for<DeepbookError>()(DEEPBOOK_ERROR_TAGS, (err) =>
					deepbookPluginError('publish', `deepbook acquire failed: ${String(err)}`, {
						cause: err,
					}),
				),
			),
	});
};

function buildLocalPluginPublic<
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec>,
	const Pyth extends PythOptions | undefined = undefined,
>(
	opts: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
): DeepbookLocalMember<Publisher, Package, Pools, Pyth>;
function buildLocalPluginPublic<
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec>,
	const Pyth extends PythOptions | undefined = undefined,
>(opts: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>) {
	return buildLocalPlugin(opts);
}

// ---------------------------------------------------------------------------
// Plugin construction — known
// ---------------------------------------------------------------------------

const buildKnownPlugin = (opts: DeepbookKnownOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	const known = opts.network ? KNOWN_DEEPBOOK_DEPLOYMENTS[opts.network] : null;
	const packageId = opts.packageId ?? known?.packageId;
	const registryId = opts.registryId ?? known?.registryId;
	if (!packageId || !registryId) {
		throw deepbookConfigError(
			'packageId',
			`deepbook({mode:'known', name:'${name}'}) requires packageId and registryId, or network:'mainnet'|'testnet'.`,
			`Pass explicit ids or use deepbook({mode:'known', network:'testnet'}).`,
		);
	}
	const deepbookResource = makeDeepbookResource(name);
	const snap = makeKnownSnapshotable({ name });

	return definePlugin({
		id: deepbookResource.id,
		dependsOn: [suiResource] as const,
		role: 'task',
		section: 'service',
		pluginKey: deepbookPluginKey(name),
		// `deps` auto-infers the resolved `[sui]` tuple from the
		// `[suiResource] as const` dependency. `ctx` arrives via the
		// `PluginContext` service.
		start: (deps) =>
			Effect.gen(function* () {
				const ctx = yield* PluginContext;
				const identity = yield* IdentityContext;
				const [sui] = deps;
				const network = opts.network ?? known?.network ?? identity.network;
				const resolved: DeepbookResolved = {
					mode: 'known',
					network,
					packageId,
					registryId,
					adminCapId: null,
					deepTreasuryId: known?.deepTreasuryId ?? null,
					pools: [],
					pyth: known?.pyth ?? null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: false,
					// DEEP funding is a testnet-deepbook concern — gate on the
					// network name alone. (The old `&& String(chain) === 'sui:testnet'`
					// conjunct compared a genesis-digest chainId against a network
					// literal and was dead for every non-literal `chain` value.)
					deepFundingStrategy:
						opts.network === 'testnet'
							? makeDeepbookDeepFundingStrategy({ suiSdk: sui.sdk })
							: null,
				};
				// Emit contributions inline: snapshot -> codegen -> (optional
				// DEEP funding strategy). `resolved` is the just-computed value;
				// `snap` is the known-mode identity-guard snapshotable in scope.
				// The DEEP funding contributor is emitted only when
				// `resolved.deepFundingStrategy` is non-null.
				const bindings: DeepbookBindings = {
					name,
					network: resolved.network,
					packageId: resolved.packageId,
					registryId: resolved.registryId,
					adminCapId: null,
					deepTreasuryId: resolved.deepTreasuryId,
					pools: [],
					pyth: resolved.pyth
						? {
								packageId: resolved.pyth.packageId,
								stateId: resolved.pyth.stateId,
								wormholeStateId: resolved.pyth.wormholeStateId,
								feeds: resolved.pyth.feeds.map((feed) => ({
									symbol: feed.symbol,
									feedId: feed.feedId,
									priceInfoObjectId: feed.priceInfoObjectId,
									price: feed.price.toString(),
									expo: feed.expo,
								})),
							}
						: null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
				};
				ctx.snapshotExtra(snap);
				ctx.codegen(makeDeepbookCodegenable(bindings));
				if (resolved.deepFundingStrategy != null) {
					ctx.provides(makeDeepbookDeepFundingContribution(resolved.deepFundingStrategy));
				}
				return resolved;
			}),
	});
};

// ---------------------------------------------------------------------------
// Default option resolution (env-driven)
// ---------------------------------------------------------------------------

const resolveDefaultMode = <
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
	const Pyth extends PythOptions | undefined = undefined,
>(
	opts?: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
): DeepbookOptions<Publisher, Pyth> => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.DEVSTACK_NETWORK;
	if (env === undefined || env === 'localnet') {
		// Local DeepBook: default to local mode on localnet. The caller must
		// supply explicit `{ publisher, package, pools }`; `resolveLocalOptions`
		// fails fast otherwise (no auto-synthesis).
		return { mode: 'local', ...opts } as DeepbookOptions<Publisher, Pyth>;
	}
	// Non-local default: refuse — known mode requires explicit
	// packageId/registryId. The user passes them via
	// `deepbookFor(network).known({...})` or `deepbook({mode:'known',...})`.
	throw deepbookConfigError(
		'mode',
		`deepbook(): cannot auto-default to known mode on network='${env}'.`,
		`Use deepbookFor(network).known({packageId, registryId, ...}).`,
	);
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Env-driven factory. Defaults to local mode on localnet when passed local
 *  options. Explicit `override` and `known` modes bypass env inference. */
type DeepbookLocalMember<
	Publisher extends AccountMemberAlias,
	Package extends DeepbookPackageMember,
	Pools extends ReadonlyArray<DeepbookPoolSpec>,
	Pyth extends PythOptions | undefined = undefined,
> = ReturnType<typeof buildLocalPlugin<Publisher, Package, Pools, Pyth>>;
type DeepbookOverrideMember = ReturnType<typeof buildOverridePlugin>;
type DeepbookKnownMember = ReturnType<typeof buildKnownPlugin>;

// Local DeepBook requires explicit `{ publisher, package, pools }`. There is
// no zero-arg/synthesized overload — an under-specified call fails fast (see
// `resolveLocalOptions`).
export function deepbookCore<
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
	const Pyth extends PythOptions | undefined = undefined,
>(
	opts: { readonly mode: 'local' } & DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
): DeepbookLocalMember<Publisher, Package, Pools, Pyth>;
export function deepbookCore(
	opts: { readonly mode: 'override' } & DeepbookOverrideOptions,
): DeepbookOverrideMember;
export function deepbookCore(
	opts: { readonly mode: 'known' } & DeepbookKnownOptions,
): DeepbookKnownMember;
export function deepbookCore<
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
	const Pyth extends PythOptions | undefined = undefined,
>(
	opts: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
): DeepbookLocalMember<Publisher, Package, Pools, Pyth>;
export function deepbookCore<
	const Publisher extends AccountMemberAlias,
	const Package extends DeepbookPackageMember,
	const Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
	const Pyth extends PythOptions | undefined = undefined,
>(
	opts?: DeepbookLocalOptions<Publisher, Package, Pools, Pyth> | DeepbookOptions<Publisher, Pyth>,
):
	| DeepbookLocalMember<Publisher, Package, Pools, Pyth>
	| DeepbookOverrideMember
	| DeepbookKnownMember {
	const resolved: DeepbookOptions<Publisher, Pyth> =
		opts !== undefined && 'mode' in opts
			? (opts as DeepbookOptions<Publisher, Pyth>)
			: resolveDefaultMode(
					opts as DeepbookLocalOptions<Publisher, Package, Pools, Pyth> | undefined,
				);
	switch (resolved.mode) {
		case 'local': {
			const localOpts = resolved as { readonly mode: 'local' } & DeepbookLocalOptions<
				Publisher,
				Package,
				Pools,
				Pyth
			>;
			// Explicit-config path only; `buildLocalPlugin` -> `resolveLocalOptions`
			// fails fast when `publisher`/`package`/`pools` are missing.
			return buildLocalPluginPublic(localOpts) as DeepbookLocalMember<
				Publisher,
				Package,
				Pools,
				Pyth
			>;
		}
		case 'override':
			return buildOverridePlugin(resolved);
		case 'known':
			return buildKnownPlugin(resolved);
	}
}

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const local = { mode: 'local', chain: 'sui:localnet' } as const;
 *      deepbookFor(local).local({publisher, package, pools})    // OK
 *      deepbookFor(local).override({packageId, registryId, adminCapId}) // OK
 *      deepbookFor(local).known({...})                          // OK
 *
 *      const fork = { mode: 'fork', chain: 'sui:mainnet-fork', upstream: 'mainnet' } as const;
 *      deepbookFor(fork).local({...})                       // COMPILE ERROR
 *      deepbookFor(fork).override({...})                    // COMPILE ERROR
 *
 *  The fork branch has NO `.local` or `.override` entry — `deepbookFor(forkNetwork).local`
 *  is a compile-time refusal. */
export const deepbookFor = defineModeNamespace({
	local: {
		local: <
			const Publisher extends AccountMemberAlias,
			const Package extends DeepbookPackageMember,
			const Pools extends ReadonlyArray<DeepbookPoolSpec> = readonly [],
			const Pyth extends PythOptions | undefined = undefined,
		>(
			opts: DeepbookLocalOptions<Publisher, Package, Pools, Pyth>,
		) => buildLocalPluginPublic(opts),
		override: (opts: DeepbookOverrideOptions) => buildOverridePlugin(opts),
		known: (opts: DeepbookKnownOptions) => buildKnownPlugin(opts),
	},
	live: {
		known: (opts: DeepbookKnownOptions) => buildKnownPlugin(opts),
	},
	fork: {
		// `.override` intentionally absent — compile-time refusal.
		known: (opts: DeepbookKnownOptions) => buildKnownPlugin(opts),
	},
});

export { deepbookCore as deepbook };

// ---------------------------------------------------------------------------
// Re-exports for advanced callers
// ---------------------------------------------------------------------------

export {
	DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY,
	DEEPBOOK_TESTNET_DEEP_COIN_TYPE,
} from './faucet-strategy.ts';
export {
	type DeepbookError,
	type DeepbookPluginError,
	type DeepbookConfigError,
	type DeepbookPhase,
} from './errors.ts';
export type { DeepbookBindings, DeepbookPoolBinding } from './codegen.ts';
export type {
	AccountMemberAlias,
	CoinMemberAlias,
	DeepbookPackageMember,
	DeepbookPool,
	DeepbookPoolCoin,
	DeepbookPoolSeedLiquidity,
	DeepbookPoolSeedOrder,
	DeepbookPoolSpec,
} from './types.ts';
export {
	DEEP_PRICE_FEED_ID,
	pythPriceFeedId,
	SUI_PRICE_FEED_ID,
	USDC_PRICE_FEED_ID,
} from './types.ts';
