// Deepbook plugin — barrel + factories.
//
// Architecture: Deepbook is a task plugin that resolves a known
// DeepBook deployment, or an explicit caller-supplied override, and
// emits bindings.
//
// Mode discipline:
//
//   - `deepbook(opts)`             — explicit mode selection.
//   - `deepbookFor(network).override` — local-branch override for
//                                     caller-supplied deployment ids.
//   - `deepbookFor(network).known` — known-deployment branch (live +
//                                     fork networks; wraps an already-
//                                     deployed canonical instance).
//
// Capability decls emitted:
//
//   Override mode:
//     1. snapshotable        — identity guard only.
//     2. codegenable         — `deepbook-network` bindings.
//
//   Known mode:
//     1. snapshotable        — identity guard only.
//     2. codegenable         — `deepbook-network` bindings (mode='known').
//
// Resource id: `deepbook/<name>`. Plugin key: `deepbook:<name>`.

import { Effect } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import { suiResource } from '../sui/index.ts';

import { deepbookPluginKey } from './plugin-key.ts';
import { DEEPBOOK_ERROR_TAGS, deepbookConfigError } from './errors.ts';
import { makeDeepbookCodegenable, type DeepbookBindings } from './codegen.ts';
import {
	makeDeepbookDeepFundingContribution,
	makeDeepbookDeepFundingStrategy,
	type DeepbookDeepFundingStrategy,
} from './faucet-strategy.ts';
import { makeKnownSnapshotable } from './snapshot.ts';
import type { DeepbookPool, PythHandle } from './types.ts';

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
	readonly mode: 'override' | 'known';
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
	readonly chain?: string;
}

export type DeepbookKnownNetwork = 'mainnet' | 'testnet';

interface DeepbookKnownCommonOptions extends DeepbookCommonOptions {
	/** Optional chain id pin (defaults to the configured network). */
	readonly chain?: string;
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

export type DeepbookOptions =
	| ({ readonly mode: 'override' } & DeepbookOverrideOptions)
	| ({ readonly mode: 'known' } & DeepbookKnownOptions);

// ---------------------------------------------------------------------------
// Plugin construction — override
// ---------------------------------------------------------------------------

const DEFAULT_NAME = 'deepbook';
const deepbookErrorContributions = pluginErrorContributions(DEEPBOOK_ERROR_TAGS);

const KNOWN_DEEPBOOK_DEPLOYMENTS: Record<
	DeepbookKnownNetwork,
	{
		readonly chain: string;
		readonly packageId: string;
		readonly registryId: string;
		readonly pyth: PythHandle;
	}
> = {
	testnet: {
		chain: 'sui:testnet',
		packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
		registryId: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
		pyth: {
			stateId: '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
			wormholeStateId: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
			feeds: [],
		},
	},
	mainnet: {
		chain: 'sui:mainnet',
		packageId: '0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e',
		registryId: '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d',
		pyth: {
			stateId: '0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8',
			wormholeStateId: '0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c',
			feeds: [],
		},
	},
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
		pluginKey: deepbookPluginKey(name),
		start: (deps) =>
			Effect.sync(() => {
				const [sui] = deps;
				const chain = opts.chain ?? sui.chain;
				const resolved: DeepbookResolved = {
					mode: 'override',
					chain,
					packageId: opts.packageId,
					registryId: opts.registryId,
					adminCapId: opts.adminCapId,
					pools: [],
					pyth: null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: false,
					deepFundingStrategy: null,
				};
				return resolved;
			}),
		capabilities: ({ value: resolved }) => {
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
			const codegen: CodegenableDecl<'deepbook-network'> = makeDeepbookCodegenable(bindings);
			return [snap, codegen] as const;
		},
		errorContributions: deepbookErrorContributions,
	});
};

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
		start: (deps) =>
			Effect.sync(() => {
				const [sui] = deps;
				const chain = opts.chain ?? known?.chain ?? sui.chain;
				const resolved: DeepbookResolved = {
					mode: 'known',
					chain,
					packageId,
					registryId,
					adminCapId: null,
					pools: [],
					pyth: known?.pyth ?? null,
					margin: null,
					serverUrl: null,
					indexerUrl: null,
					marketMakerRunning: false,
					deepFundingStrategy:
						opts.network === 'testnet' && String(chain) === 'sui:testnet'
							? makeDeepbookDeepFundingStrategy({ suiSdk: sui.sdk })
							: null,
				};
				return resolved;
			}),
		capabilities: ({ value: resolved }) => {
			const bindings: DeepbookBindings = {
				name,
				chain: resolved.chain,
				packageId: resolved.packageId,
				registryId: resolved.registryId,
				adminCapId: null,
				pools: [],
				pyth: resolved.pyth
					? {
							stateId: resolved.pyth.stateId,
							wormholeStateId: resolved.pyth.wormholeStateId,
						}
					: null,
				margin: null,
				serverUrl: null,
				indexerUrl: null,
			};
			const deepFunding =
				resolved.deepFundingStrategy === null
					? []
					: [makeDeepbookDeepFundingContribution(resolved.deepFundingStrategy)];
			return [snap, makeDeepbookCodegenable(bindings), ...deepFunding] as const;
		},
		errorContributions: deepbookErrorContributions,
	});
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Explicit DeepBook factory. Override mode wraps caller-supplied ids;
 *  known mode wraps built-in or explicit known deployment ids. */
type DeepbookOverrideMember = ReturnType<typeof buildOverridePlugin>;
type DeepbookKnownMember = ReturnType<typeof buildKnownPlugin>;

export function deepbookCore(
	opts: { readonly mode: 'override' } & DeepbookOverrideOptions,
): DeepbookOverrideMember;
export function deepbookCore(
	opts: { readonly mode: 'known' } & DeepbookKnownOptions,
): DeepbookKnownMember;
export function deepbookCore(opts: DeepbookOptions): DeepbookOverrideMember | DeepbookKnownMember {
	switch (opts.mode) {
		case 'override':
			return buildOverridePlugin(opts);
		case 'known':
			return buildKnownPlugin(opts);
	}
}

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const local = { mode: 'local', chain: 'sui:localnet' } as const;
 *      deepbookFor(local).override({packageId, registryId, adminCapId}) // OK
 *      deepbookFor(local).known({...})                                  // OK
 *
 *      const fork = { mode: 'fork', chain: 'sui:mainnet-fork', upstream: 'mainnet' } as const;
 *      deepbookFor(fork).override({...})                    // COMPILE ERROR
 *
 *  The fork branch has NO `.override` entry — `deepbookFor(forkNetwork).override`
 *  is a compile-time refusal. */
export const deepbookFor = defineModeNamespace({
	local: {
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

export const deepbook = deepbookCore;

// ---------------------------------------------------------------------------
// Re-exports for advanced callers
// ---------------------------------------------------------------------------

export {
	DEEPBOOK_DEEP_FAUCET_STRATEGY_KEY,
	DEEPBOOK_TESTNET_DEEP_COIN_TYPE,
	makeDeepbookDeepFundingContribution,
	makeDeepbookDeepFundingStrategy,
	type DeepbookDeepFundingStrategy,
	type DeepbookDeepFundingStrategyOptions,
} from './faucet-strategy.ts';
export {
	DEEPBOOK_ERROR_TAGS,
	type DeepbookError,
	type DeepbookPluginError,
	type DeepbookConfigError,
	type DeepbookPhase,
} from './errors.ts';
export type { DeepbookBindings, DeepbookPoolBinding } from './codegen.ts';
export type { AccountMemberAlias, DeepbookPool, PythHandle, PythPriceFeedId } from './types.ts';
