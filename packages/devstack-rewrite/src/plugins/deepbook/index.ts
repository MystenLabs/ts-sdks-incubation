// Deepbook plugin — barrel + factories.
//
// Architecture: Deepbook is the THIRD composite primitive (after
// walrus + seal). One supervisor row, many children:
//
//   - The Move-package publish (deepbook v3).
//   - Existing local deployments identified by explicit environment
//     overrides.
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
//     2. snapshotable        — `deepbook/<name>` subtree.
//     3. codegenable         — `deepbook-network` bindings.
//
//   Known mode:
//     1. snapshotable        — identity guard only.
//     2. codegenable         — `deepbook-network` bindings (mode='known').
//
// Tag id: `deepbook/<name>`. Plugin key: `deepbook:<name>`.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { consumeMember } from '../../api/consume-members.ts';
import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
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
import { makeKnownSnapshotable, makeLocalSnapshotable } from './snapshot.ts';
import type { AccountMemberAlias, DeepbookPool, PythHandle } from './types.ts';

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
export interface DeepbookLocalOptions<
	Publisher extends AccountMemberAlias = AccountMemberAlias,
> extends DeepbookCommonOptions {
	/** Publisher account — Direct Member Ref (locked API decision). */
	readonly publisher: Publisher;
}

export interface DeepbookKnownOptions extends DeepbookCommonOptions {
	/** Pre-deployed package id (canonical testnet/mainnet deepbook). */
	readonly packageId: string;
	readonly registryId: string;
	/** Optional chain id pin (defaults to the configured network). */
	readonly chain?: string;
}

export type DeepbookOptions<Publisher extends AccountMemberAlias = AccountMemberAlias> =
	| ({ readonly mode: 'local' } & DeepbookLocalOptions<Publisher>)
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

const buildLocalPlugin = <const Publisher extends AccountMemberAlias>(
	opts: DeepbookLocalOptions<Publisher>,
) => {
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

	const publisherMember = consumeMember(opts.publisher);
	const consumesTuple = [SuiTag, publisherMember.consumesTag] as const;

	return defineNodePlugin({
		provides: tag,
		consumes: consumesTuple,
		kind: 'composite',
		rebootCost: 'heavy',
		acquire: (ctx) =>
			Effect.gen(function* () {
				const sui = ctx.get(SuiTag);
				const publisher = publisherMember.projectInScope(ctx);

				yield* Effect.annotateCurrentSpan({
					'deepbook.name': name,
					'deepbook.chain': sui.chain,
					'deepbook.publisher': publisher.address,
				});

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
				indexerEnabled: false,
				serverEnabled: false,
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
			Effect.sync(() => {
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

const resolveDefaultMode = <const Publisher extends AccountMemberAlias>(
	opts?: DeepbookLocalOptions<Publisher>,
): DeepbookOptions<Publisher> => {
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
type DeepbookLocalMember<Publisher extends AccountMemberAlias> = ReturnType<
	typeof buildLocalPlugin<Publisher>
>;
type DeepbookKnownMember = ReturnType<typeof buildKnownPlugin>;

export function deepbookCore<const Publisher extends AccountMemberAlias>(
	opts: { readonly mode: 'local' } & DeepbookLocalOptions<Publisher>,
): DeepbookLocalMember<Publisher>;
export function deepbookCore(
	opts: { readonly mode: 'known' } & DeepbookKnownOptions,
): DeepbookKnownMember;
export function deepbookCore<const Publisher extends AccountMemberAlias>(
	opts: DeepbookLocalOptions<Publisher>,
): DeepbookLocalMember<Publisher>;
export function deepbookCore<const Publisher extends AccountMemberAlias>(
	opts?: DeepbookLocalOptions<Publisher> | DeepbookOptions<Publisher>,
): DeepbookLocalMember<Publisher> | DeepbookKnownMember {
	const resolved: DeepbookOptions<Publisher> =
		opts !== undefined && 'mode' in opts
			? (opts as DeepbookOptions<Publisher>)
			: resolveDefaultMode(opts as DeepbookLocalOptions<Publisher> | undefined);
	switch (resolved.mode) {
		case 'local':
			return buildLocalPlugin(resolved);
		case 'known':
			return buildKnownPlugin(resolved);
	}
}

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const local = { mode: 'local', chain: 'sui:localnet' } as const;
 *      deepbookFor(local).local({publisher})                // OK
 *      deepbookFor(local).known({...})                      // OK (always available)
 *
 *      const fork = { mode: 'fork', chain: 'sui:mainnet-fork', upstream: 'mainnet' } as const;
 *      deepbookFor(fork).local({publisher})                 // COMPILE ERROR
 *
 *  The fork branch has NO `.local` entry — `deepbookFor(forkNetwork).local`
 *  is a compile-time refusal. Defense-in-depth runtime refusal via
 *  `forkIncompatibleError`. */
export const deepbookFor = defineModeNamespace({
	local: {
		local: <const Publisher extends AccountMemberAlias>(opts: DeepbookLocalOptions<Publisher>) =>
			buildLocalPlugin(opts),
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
export type { AccountMemberAlias, DeepbookPool, PythHandle, PythPriceFeedId } from './types.ts';
