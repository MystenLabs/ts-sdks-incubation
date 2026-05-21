// Deepbook plugin — barrel + factories.
//
// Architecture: Deepbook is the THIRD composite primitive (after
// walrus + seal). One supervisor row, many children:
//
//   - The Move-package publish (deepbook v3).
//   - Per-pool creation (whitelisted pools).
//   - Pyth internal module (`pyth/`) — publishes pyth/wormhole pkgs
//     + initializes feed prices + optionally runs a pusher fiber.
//     Pyth is folded INTO deepbook per memory
//     `project_pyth_inside_deepbook` (not a top-level `pyth()`
//     factory).
//   - Optional margin module publish (separate Move package).
//   - Optional indexer container (Rust binary writing to postgres).
//   - Optional REST server container (Rust binary reading postgres).
//   - Optional market-maker fiber (forked-scoped long-running grid).
//
// Mode discipline:
//
//   - `deepbook(opts)`             — env-driven mode selection.
//                                     Defaults to local.
//   - `deepbookFor(network).local` — mode-narrowed namespace.
//                                     fork branch has NO `.local` —
//                                     compile error on fork networks.
//   - `deepbookFor(network).known` — known-deployment branch (live +
//                                     fork networks; wraps an already-
//                                     deployed canonical instance).
//
// Capability decls emitted:
//
//   Local mode:
//     1. composite-primitive — one row + lifted siblings + inner pts.
//     2. snapshotable        — `deepbook/<name>` subtree + managed
//                              containers (indexer + server when on).
//     3. codegenable         — `deepbook-network` bindings.
//     4. routable            — `deepbook-server` HTTP endpoint when
//                              `server` is enabled.
//
//   Known mode:
//     1. snapshotable        — identity guard only.
//     2. codegenable         — `deepbook-network` bindings (mode='known').
//
// Tag id: `deepbook/<name>`. Plugin key: `deepbook:<name>`.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { RoutableDecl } from '../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import { SuiTag } from '../sui/index.ts';

import { makeDeepbookComposite } from './composite.ts';
import {
	DEEPBOOK_ERROR_TAGS,
	deepbookConfigError,
	deepbookPluginError,
	forkIncompatibleError,
	type DeepbookError,
	type DeepbookPluginError,
} from './errors.ts';
import { makeDeepbookCodegenable, type DeepbookBindings } from './codegen.ts';
import { makeServerRoutable } from './routable.ts';
import { makeKnownSnapshotable, makeLocalSnapshotable } from './snapshot.ts';
import type {
	AccountMemberAlias,
	DeepbookMarginOptions,
	DeepbookMarketMakerOptions,
	DeepbookPool,
	DeepbookPoolSpec,
	PackageMemberAlias,
	PythHandle,
	PythOptions,
} from './types.ts';

// ---------------------------------------------------------------------------
// Tag — the resolved value all consumers read
// ---------------------------------------------------------------------------

export type DeepbookTagId<Name extends string> = `deepbook/${Name}`;

const makeDeepbookTag = <Name extends string>(name: Name) =>
	defineTag<DeepbookTagId<Name>, DeepbookResolved>(
		`deepbook/${name}` as DeepbookTagId<Name>,
		'deepbook',
	);

/** The deepbook resolved value. Mode-asymmetric:
 *
 *   - `adminCapId` is `null` for known-deployment mode.
 *   - `margin` / `serverUrl` / `indexerUrl` / `marketMakerRunning`
 *     are `null` when the corresponding sub-feature is not enabled. */
export interface DeepbookResolved {
	readonly mode: 'local' | 'known';
	readonly chain: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly pools: ReadonlyArray<DeepbookPool>;
	readonly pyth: PythHandle | null;
	readonly margin: {
		readonly packageId: string;
		readonly registryId: string;
	} | null;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
	readonly marketMakerRunning: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeepbookCommonOptions {
	readonly name?: string;
}

/** Local mode wraps an explicitly supplied local deployment. */
export interface DeepbookLocalOptions extends DeepbookCommonOptions {
	/** Publisher account — Direct Member Ref (locked API decision). */
	readonly publisher: AccountMemberAlias;
	/** Optional source path retained for config parity. */
	readonly movePackagePath?: string;
	/** Pool specs require a real local deployment path at runtime. */
	readonly pools?: ReadonlyArray<DeepbookPoolSpec>;
	/** Pyth oracle wiring (folded INSIDE deepbook). Optional. */
	readonly pyth?: PythOptions;
	/** Margin module wiring. Optional. */
	readonly margin?: DeepbookMarginOptions;
	/** Postgres ref (for indexer + server). Direct member ref (typed
	 *  loosely; the composite checks shape at acquire). */
	readonly postgres?: unknown;
	/** Indexer container — defaults off. */
	readonly indexer?: boolean | { readonly image?: string };
	/** Server container — defaults off. */
	readonly server?: boolean | { readonly image?: string };
	/** Market-maker fiber — defaults off. */
	readonly marketMaker?: DeepbookMarketMakerOptions;
	/** Per-coin overrides — coin members whose `provides` carries
	 *  `coin:<SYMBOL>` literal tag ids. Direct member refs (locked
	 *  API decision). */
	readonly coins?: ReadonlyArray<PackageMemberAlias>;
}

export interface DeepbookKnownOptions extends DeepbookCommonOptions {
	/** Pre-deployed package id (canonical testnet/mainnet deepbook). */
	readonly packageId: string;
	readonly registryId: string;
	/** Optional chain id pin (defaults to the configured network). */
	readonly chain?: string;
}

export type DeepbookOptions =
	| ({ readonly mode: 'local' } & DeepbookLocalOptions)
	| ({ readonly mode: 'known' } & DeepbookKnownOptions);

// ---------------------------------------------------------------------------
// Plugin construction — local
// ---------------------------------------------------------------------------

const DEFAULT_NAME = 'deepbook';

const LOCAL_DEPLOYMENT_ENV = [
	'DEEPBOOK_PACKAGE_OVERRIDE_PACKAGE_ID',
	'DEEPBOOK_PACKAGE_OVERRIDE_REGISTRY_ID',
	'DEEPBOOK_PACKAGE_OVERRIDE_ADMIN_CAP_ID',
] as const;

const unsupportedLocalFeatures = (opts: DeepbookLocalOptions): ReadonlyArray<string> => {
	const features: string[] = [];
	if (opts.movePackagePath !== undefined) features.push('movePackagePath');
	if ((opts.pools ?? []).length > 0) features.push('pools');
	if (opts.pyth !== undefined) features.push('pyth');
	if (opts.margin !== undefined) features.push('margin');
	if (opts.postgres !== undefined) features.push('postgres');
	if (opts.indexer !== undefined && opts.indexer !== false) features.push('indexer');
	if (opts.server !== undefined && opts.server !== false) features.push('server');
	if (opts.marketMaker !== undefined) features.push('marketMaker');
	if ((opts.coins ?? []).length > 0) features.push('coins');
	return features;
};

const readRequiredLocalDeployment = (
	env: Record<string, string | undefined> | undefined,
): Effect.Effect<
	{
		readonly packageId: string;
		readonly registryId: string;
		readonly adminCapId: string;
	},
	DeepbookPluginError
> => {
	const packageId = env?.DEEPBOOK_PACKAGE_OVERRIDE_PACKAGE_ID;
	const registryId = env?.DEEPBOOK_PACKAGE_OVERRIDE_REGISTRY_ID;
	const adminCapId = env?.DEEPBOOK_PACKAGE_OVERRIDE_ADMIN_CAP_ID;
	const missing = LOCAL_DEPLOYMENT_ENV.filter((key) => env?.[key] === undefined || env[key] === '');
	if (missing.length > 0) {
		return Effect.fail(
			deepbookPluginError(
				'publish',
				`deepbook local mode requires explicit deployment ids: ${missing.join(', ')}.`,
			),
		);
	}
	return Effect.succeed({
		packageId: packageId as string,
		registryId: registryId as string,
		adminCapId: adminCapId as string,
	});
};

const buildLocalPlugin = (opts: DeepbookLocalOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	if (!opts.publisher) {
		// Synchronous factory-time refusal — mirrors walrus / seal
		// patterns. Surfaces as a thrown DeepbookConfigError to the
		// user at config-construction time, not at acquire.
		throw deepbookConfigError(
			'publisher',
			`deepbook({mode:'local', name:'${name}'}) requires a publisher account ref.`,
			`Pass \`publisher: <accountMember>\` — the account member returned by \`account('publisher')\`.`,
		);
	}

	const tag = makeDeepbookTag(name);

	const composite = makeDeepbookComposite({
		name,
		liftedSiblings: [],
		innerParticipants: [],
	});

	const indexerEnabled = opts.indexer !== undefined && opts.indexer !== false;
	const serverEnabled = opts.server !== undefined && opts.server !== false;

	return defineNodePlugin({
		provides: tag,
		// SuiTag is the hard upstream. Account / package / coin /
		// postgres members the user passed are NOT in `consumes` here
		// — the composite walks them directly via the StackMember
		// references threaded in `opts.publisher` etc. The substrate's
		// topological scheduler still orders them correctly because the
		// `acquire` body yields the substrate's services; per-member
		// resolution happens via the BuildContext.
		consumes: [SuiTag] as const,
		kind: 'composite',
		rebootCost: 'heavy',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);

				yield* Effect.annotateCurrentSpan({
					'deepbook.name': name,
					'deepbook.chain': sui.chain,
					'deepbook.poolsRequested': (opts.pools ?? []).length,
					'deepbook.pythEnabled': opts.pyth !== undefined,
					'deepbook.marginEnabled': opts.margin !== undefined,
					'deepbook.indexerEnabled': indexerEnabled,
					'deepbook.serverEnabled': serverEnabled,
					'deepbook.marketMakerEnabled': opts.marketMaker !== undefined,
				});

				const unsupported = unsupportedLocalFeatures(opts);
				if (unsupported.length > 0) {
					return yield* Effect.fail(
						deepbookPluginError(
							'publish',
							`deepbook local mode cannot acquire release-facing ${unsupported.join(
								', ',
							)} behavior from the current runtime. Use deepbook({ mode: 'known', packageId, registryId }) for an existing deployment, or remove those options.`,
						),
					);
				}

				const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
					.process?.env;
				const deployment = yield* readRequiredLocalDeployment(env);

				const resolved: DeepbookResolved = {
					mode: 'local',
					chain: sui.chain,
					packageId: deployment.packageId,
					registryId: deployment.registryId,
					adminCapId: deployment.adminCapId,
					pools: [],
					pyth: null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: false,
				};
				return resolved;
			}).pipe(
				Effect.catch((err: unknown) => {
					// Typed plugin errors flow through; other errors
					// (substrate primitives) are wrapped under a
					// `'publish'` phase tag so the cascade walker keeps
					// the plugin attribution.
					if (
						typeof err === 'object' &&
						err !== null &&
						'_tag' in err &&
						(err._tag === 'DeepbookPluginError' ||
							err._tag === 'DeepbookConfigError' ||
							err._tag === 'ForkIncompatibleError')
					) {
						return Effect.fail(err as DeepbookError);
					}
					return Effect.fail(
						deepbookPluginError('publish', `deepbook acquire failed: ${String(err)}`),
					);
				}),
			),
		capabilities: (resolved, acquireCtx) => {
			const snap: SnapshotableDecl = makeLocalSnapshotable({
				name,
				app: acquireCtx.identity.app,
				stack: acquireCtx.identity.stack,
				indexerEnabled,
				serverEnabled,
			});
			const bindings: DeepbookBindings = {
				name,
				chain: resolved.chain,
				packageId: resolved.packageId,
				registryId: resolved.registryId,
				adminCapId: resolved.adminCapId,
				pools: resolved.pools.map((p) => ({
					name: p.name,
					poolId: p.poolId,
					baseCoinType: p.baseCoinType,
					quoteCoinType: p.quoteCoinType,
				})),
				pyth: resolved.pyth
					? {
							stateId: resolved.pyth.stateId,
							wormholeStateId: resolved.pyth.wormholeStateId,
						}
					: null,
				margin: resolved.margin,
				serverUrl: resolved.serverUrl,
				indexerUrl: resolved.indexerUrl,
			};
			const codegen: CodegenableDecl<DeepbookBindings, 'deepbook-network'> =
				makeDeepbookCodegenable(bindings);
			if (serverEnabled) {
				const routable: RoutableDecl = makeServerRoutable({
					name,
					containerName: `devstack-${acquireCtx.identity.app}-${acquireCtx.identity.stack}-deepbook-${name}-server`,
				});
				return capabilities(composite, snap, codegen, routable);
			}
			return capabilities(composite, snap, codegen);
		},
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: DEEPBOOK_ERROR_TAGS }],
		liftedSiblings: [],
	});
};

// ---------------------------------------------------------------------------
// Plugin construction — known
// ---------------------------------------------------------------------------

const buildKnownPlugin = (opts: DeepbookKnownOptions) => {
	const name = opts.name ?? DEFAULT_NAME;
	const tag = makeDeepbookTag(name);
	const snap = makeKnownSnapshotable({ name });

	return defineNodePlugin({
		provides: tag,
		consumes: [SuiTag] as const,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				const resolved: DeepbookResolved = {
					mode: 'known',
					chain: opts.chain ?? sui.chain,
					packageId: opts.packageId,
					registryId: opts.registryId,
					adminCapId: null,
					pools: [],
					pyth: null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: false,
				};
				return resolved;
			}),
		capabilities: (resolved) => {
			const bindings: DeepbookBindings = {
				name,
				chain: resolved.chain,
				packageId: resolved.packageId,
				registryId: resolved.registryId,
				adminCapId: null,
				pools: [],
				pyth: null,
				margin: null,
				serverUrl: null,
				indexerUrl: null,
			};
			return capabilities(snap, makeDeepbookCodegenable(bindings));
		},
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: DEEPBOOK_ERROR_TAGS }],
	});
};

// ---------------------------------------------------------------------------
// Default option resolution (env-driven)
// ---------------------------------------------------------------------------

const resolveDefaultMode = (opts?: DeepbookLocalOptions): DeepbookOptions => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.DEVSTACK_NETWORK;
	if (env === undefined || env === 'localnet') {
		if (!opts || !opts.publisher) {
			throw deepbookConfigError(
				'publisher',
				`deepbook() on localnet requires \`publisher: <accountMember>\`.`,
				`Pass options via deepbook({mode:'local', publisher: <accountMember>, ...}).`,
			);
		}
		return { mode: 'local', ...opts };
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

/** Env-driven factory. Defaults to local mode on localnet (requires
 *  `publisher`). Other modes route through `deepbookFor(network)`. */
export const deepbookCore = (opts?: DeepbookLocalOptions | DeepbookOptions) => {
	const resolved: DeepbookOptions =
		opts !== undefined && 'mode' in opts
			? (opts as DeepbookOptions)
			: resolveDefaultMode(opts as DeepbookLocalOptions | undefined);
	switch (resolved.mode) {
		case 'local':
			return buildLocalPlugin(resolved);
		case 'known':
			return buildKnownPlugin(resolved);
	}
};

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const local = { mode: 'local', chain: 'sui:localnet' } as const;
 *      deepbookFor(local).local({publisher, pools, ...})    // OK
 *      deepbookFor(local).known({...})                      // OK (always available)
 *
 *      const fork = { mode: 'fork', chain: 'sui:mainnet-fork', upstream: 'mainnet' } as const;
 *      deepbookFor(fork).local({publisher, ...})            // COMPILE ERROR
 *
 *  The fork branch has NO `.local` entry — `deepbookFor(forkNetwork).local`
 *  is a compile-time refusal. Defense-in-depth runtime refusal via
 *  `forkIncompatibleError`. */
export const deepbookFor = defineModeNamespace({
	local: {
		local: (opts: DeepbookLocalOptions) => buildLocalPlugin(opts),
		known: (opts: DeepbookKnownOptions) => buildKnownPlugin(opts),
	},
	live: {
		known: (opts: DeepbookKnownOptions) => buildKnownPlugin(opts),
	},
	fork: {
		// `.local` intentionally absent — compile-time refusal.
		known: (opts: DeepbookKnownOptions) => buildKnownPlugin(opts),
		_localRefused: (network: string): never => {
			throw forkIncompatibleError(network);
		},
	},
});

export const deepbook = deepbookCore;

// ---------------------------------------------------------------------------
// Re-exports for advanced callers
// ---------------------------------------------------------------------------

export { deepbookPluginKey } from './composite.ts';
export {
	DEEPBOOK_ERROR_TAGS,
	type DeepbookError,
	type DeepbookPluginError,
	type DeepbookConfigError,
	type DeepbookPhase,
} from './errors.ts';
export type { DeepbookBindings, DeepbookPoolBinding } from './codegen.ts';
export type {
	AccountMemberAlias,
	DeepbookMarginAssetConfig,
	DeepbookMarginOptions,
	DeepbookMarginPoolRegistration,
	DeepbookMarginPoolRiskConfig,
	DeepbookMarketMakerOptions,
	DeepbookMarketMakerStrategy,
	DeepbookPool,
	DeepbookPoolSpec,
	PackageMemberAlias,
	PythFeed,
	PythHandle,
	PythOptions,
	PythPriceFeedId,
} from './types.ts';
export {
	DEEP_PRICE_FEED_ID,
	DEFAULT_POOL_RISK_CONFIG,
	pythPriceFeedId,
	SUI_MARGIN_DEFAULTS,
	SUI_PRICE_FEED_ID,
	USDC_MARGIN_DEFAULTS,
	USDC_PRICE_FEED_ID,
} from './types.ts';
