// Sui plugin — barrel + factories.
//
// Architecture: Sui is the most-depended-on plugin in the stack.
// Every consumer (Account/Coin/Wallet/Faucet/Package; Walrus/Seal/
// Deepbook fork variants) reads its resolved `SuiClient` via the
// `suiResource`. The factory at this file folds the four modes behind:
//
//   - `sui(opts?)`         — env-driven mode selection. Defaults to
//                              local; overridable via the typed
//                              `opts` record (one mode per call).
//   - `suiFor(network)`    — mode-narrowed factory namespace (per
//                              architecture Tension 11). Returns
//                              `{ local: …, live: …, fork: … }`
//                              narrowed to the network's mode.
//
// The plugin emits FIVE capability decls:
//
//   1. `chain-probe:<chainId>` strategy contributor — the
//      schema-validated read surface (`makeSuiChainProbe`).
//   2. `gate:funds-ready` strategy contributor — the funds-
//      transferable gate. No-op on faucet-less networks.
//   3. `sui:seed-objects` strategy contributor — the per-instance
//      seed-objects accumulator (fork mode only; emits an empty
//      accumulator on other modes for shape uniformity).
//   4. Snapshotable — mode-aware container + bind-mount capture.
//   5. Codegenable — `sui-network` bindings (chain id, rpc, etc.).
//
// Routable contributions are MODE-DEPENDENT (local + fork yes;
// external + live no — the caller fronts their own RPC). They land
// in the per-mode builder under `mode/*.ts`; this barrel composes
// them into the plugin capability array.

import { Effect } from 'effect';

import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { definePlugin, resource } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { SnapshotableDecl } from '../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../contracts/strategy-contributor.ts';
import { FUNDS_READY_GATE_KEY } from '../../contracts/network-resolver.ts';
import type { AcquireContext } from '../../substrate/plugin.ts';

import { chainProbeCapabilityKey } from '../../contracts/chain-probe.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { IdentityContext } from '../../substrate/runtime/paths.ts';
import { PortBrokerService } from '../../substrate/runtime/port-broker/index.ts';
import { makeCodegenable } from './codegen.ts';
import type { SuiProbeKey } from './chain-probe.ts';
import { makeSnapshotable } from './snapshot.ts';
import {
	makeSeedObjectsAccumulator,
	SEED_OBJECTS_CAPABILITY_KEY,
	type SeedObjectsAccumulator,
} from './seed-objects.ts';
import { bootSuiService } from './service.ts';
import { SUI_ERROR_TAGS, SuiForkComingSoonError, type SuiPluginError } from './errors.ts';
import { makeSuiLocalRoutables } from './routable.ts';
import { faucetCapabilityKey } from '../faucet/dispatcher.ts';
import { suiLocalStrategy } from '../faucet/strategies/sui-local.ts';
import type { SuiClient } from './mode/shared.ts';
import type {
	SuiExternalOptions,
	SuiForkOptions,
	SuiLiveOptions,
	SuiLocalOptions,
	SuiOptions,
} from './mode/spec.ts';
import { parseDevstackNetwork } from '../../api/inference-network.ts';

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

/** The Sui plugin's resource identity. The id is `'sui'` (singular). */
export const suiResource = resource<'sui', SuiClient>('sui');
const suiErrorContributions = pluginErrorContributions(SUI_ERROR_TAGS);

type SuiResolved = SuiClient & {
	readonly seedObjects: SeedObjectsAccumulator;
};

// ---------------------------------------------------------------------------
// Default option resolution
// ---------------------------------------------------------------------------

/** Read `DEVSTACK_NETWORK` env (architecture: resolver precedence
 *  is CLI > env > config > default). The CLI override and config
 *  paths land in the surface layer; this helper covers the
 *  env-default path the factory uses when no `opts` is passed. */
const resolveDefaultMode = (): SuiOptions => {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env?.DEVSTACK_NETWORK;
	const parsed = parseDevstackNetwork(env);
	switch (parsed.mode) {
		case 'local':
			return { mode: 'local' };
		case 'live':
			return { mode: 'live', network: parsed.network };
	}
};

// ---------------------------------------------------------------------------
// Plugin construction (internal — used by sui() + suiFor())
// ---------------------------------------------------------------------------

const buildPlugin = (opts: SuiOptions) => {
	if (opts.mode === 'fork') {
		throw new SuiForkComingSoonError(opts.upstream);
	}
	return definePlugin({
		id: suiResource.id,
		role: 'service',
		start: () =>
			Effect.gen(function* () {
				// The substrate threads `ContainerRuntime` + `IdentityContext`
				// via the plugin runtime context; the supervisor provides
				// these before this body runs.
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const portBroker = yield* PortBrokerService;
				const { client } = yield* bootSuiService(runtime, identity, portBroker, opts);

				const seedObjects = yield* makeSeedObjectsAccumulator();
				return { ...client, seedObjects };
			}),
		capabilities: ({ value, runtime }) => makePluginCapabilities(opts, value, runtime),
		errorContributions: suiErrorContributions,
	});
};

/** Construct the capability tuple POST-acquire. Receives the resolved
 *  `SuiClient` + acquire context so decls can stamp REAL chain ids /
 *  rpc URLs into their fields instead of factory-time placeholders.
 *
 *  StrategyContributor declarations here carry real post-acquire
 *  strategy values. The generic strategy sink registers them on the
 *  scope-local `StrategyRegistry`. */
const makePluginCapabilities = (
	opts: SuiOptions,
	resolved: SuiResolved,
	acquireCtx: AcquireContext,
) => {
	const realChain = resolved.chain;
	const snap: SnapshotableDecl = makeSnapshotable(
		opts.mode,
		acquireCtx.identity.app,
		acquireCtx.identity.stack,
		realChain,
	);
	const codegen: CodegenableDecl<'sui-network'> = makeCodegenable({
		mode: opts.mode,
		chain: realChain,
		rpc: resolved.rpcUrl,
		source: 'default',
		...(resolved.faucetUrl !== null ? { faucet: resolved.faucetUrl } : {}),
		...(resolved.graphqlUrl !== null ? { graphql: resolved.graphqlUrl } : {}),
	});

	const chainProbeContribution: StrategyContributorDecl<
		`chain-probe:${string}`,
		ChainProbe<SuiProbeKey>
	> = {
		kind: 'strategy-contributor',
		capabilityKey: chainProbeCapabilityKey(realChain),
		strategy: resolved.chainProbe,
		autoMounted: true,
	};

	const fundsReadyContribution: StrategyContributorDecl<
		typeof FUNDS_READY_GATE_KEY,
		{
			readonly waitFundsReady: Effect.Effect<void, SuiPluginError>;
		}
	> = {
		kind: 'strategy-contributor',
		capabilityKey: FUNDS_READY_GATE_KEY,
		strategy: { waitFundsReady: resolved.waitForTransactionsReady.wait },
		autoMounted: true,
	};

	const seedObjectsContribution: StrategyContributorDecl<
		typeof SEED_OBJECTS_CAPABILITY_KEY,
		SeedObjectsAccumulator
	> = {
		kind: 'strategy-contributor',
		capabilityKey: SEED_OBJECTS_CAPABILITY_KEY,
		strategy: resolved.seedObjects,
		autoMounted: true,
	};

	const faucetContribution =
		resolved.faucetUrl === null
			? []
			: [
					{
						kind: 'strategy-contributor',
						capabilityKey: faucetCapabilityKey(realChain),
						strategy: suiLocalStrategy({ faucetUrl: resolved.faucetUrl }),
						autoMounted: true,
					} satisfies StrategyContributorDecl<
						`faucet:request:${string}`,
						ReturnType<typeof suiLocalStrategy>
					>,
				];

	const localRoutables =
		opts.mode === 'local'
			? makeSuiLocalRoutables({
					containerName: `devstack-${acquireCtx.identity.app}-${acquireCtx.identity.stack}-sui-validator`,
					includeGraphql: true,
				})
			: [];

	return [
		snap,
		codegen,
		chainProbeContribution,
		...faucetContribution,
		fundsReadyContribution,
		seedObjectsContribution,
		...localRoutables,
	] as const;
};

// ---------------------------------------------------------------------------
// User-facing factories
// ---------------------------------------------------------------------------

/** Env-driven factory. Defaults to `local` mode; reads
 *  `DEVSTACK_NETWORK` for non-local defaults. */
export const sui = (opts?: SuiOptions) => buildPlugin(opts ?? resolveDefaultMode());

/** Mode-narrowed factory namespace.
 *
 *  Usage:
 *      const network = { mode: 'local', chain: 'sui:localnet' } as const;
 *      suiFor(network).local({...})    // OK
 *      suiFor(network).fork({...})     // type error: 'fork' not in 'local' branch
 *
 *  The namespace MIRRORS the four mode option records: `local`,
 *  `external` (mapped onto the substrate `'local'` branch),
 *  `live`, `fork`. */
export const suiFor = defineModeNamespace({
	local: {
		local: (opts: Omit<SuiLocalOptions, 'mode'> = {}) => buildPlugin({ mode: 'local', ...opts }),
		external: (opts: Omit<SuiExternalOptions, 'mode'>) =>
			buildPlugin({ mode: 'external', ...opts }),
	},
	live: {
		testnet: (opts: Omit<SuiLiveOptions, 'mode' | 'network'> = {}) =>
			buildPlugin({ mode: 'live', network: 'testnet', ...opts }),
		mainnet: (opts: Omit<SuiLiveOptions, 'mode' | 'network'> = {}) =>
			buildPlugin({ mode: 'live', network: 'mainnet', ...opts }),
		devnet: (opts: Omit<SuiLiveOptions, 'mode' | 'network'> = {}) =>
			buildPlugin({ mode: 'live', network: 'devnet', ...opts }),
		custom: (opts: Omit<SuiLiveOptions, 'mode' | 'network'>) =>
			buildPlugin({ mode: 'live', network: 'custom', ...opts }),
	},
	fork: {
		mainnet: (opts: Omit<SuiForkOptions, 'mode' | 'upstream'> = {}) =>
			buildPlugin({ mode: 'fork', upstream: 'mainnet', ...opts }),
		testnet: (opts: Omit<SuiForkOptions, 'mode' | 'upstream'> = {}) =>
			buildPlugin({ mode: 'fork', upstream: 'testnet', ...opts }),
		devnet: (opts: Omit<SuiForkOptions, 'mode' | 'upstream'> = {}) =>
			buildPlugin({ mode: 'fork', upstream: 'devnet', ...opts }),
	},
});

// ---------------------------------------------------------------------------
// Re-exports for advanced callers (Account/Coin/Wallet/etc.) and for
// the sibling plugins (Walrus/Seal/Deepbook fork variants).
// ---------------------------------------------------------------------------

export type { SuiClient, ForkAdminSurface, WaitForTransactionsReady } from './mode/shared.ts';
export type { ResolvedSuiNetwork } from './network-resolver.ts';
export type {
	SuiOptions,
	SuiLocalOptions,
	SuiExternalOptions,
	SuiLiveOptions,
	SuiForkOptions,
	SuiPluginMode,
} from './mode/spec.ts';
export type { SuiNetworkBindings } from './codegen.ts';
export type {
	SuiError,
	SuiPluginError,
	SuiCliError,
	SuiConfigError,
	ForkUnsupportedError,
	SeedManifestMismatchError,
	SuiFundsReadyError,
} from './errors.ts';
export { SUI_ERROR_TAGS, SuiForkComingSoonError } from './errors.ts';

// Cross-plugin seams (consumed by Walrus/Seal/Deepbook fork variants
// and by Account/Coin/Wallet/Package).
export {
	chainProbeCapabilityKey,
	type ChainProbe,
	type ChainProbeError,
	type ChainProbeMode,
} from '../../contracts/chain-probe.ts';
export {
	FUNDS_READY_GATE_KEY,
	type FundsReadyStrategy,
	type FundsReadyError,
} from '../../contracts/network-resolver.ts';
export { SEED_OBJECTS_CAPABILITY_KEY, type SeedObjectsAccumulator } from './seed-objects.ts';
export {
	FORK_UNSUPPORTED_SURFACES,
	wrapWithForkGuard,
	type ForkMeta,
	type ForkLockHolder,
} from './fork-orchestration.ts';
export type { SuiProbeKey } from './chain-probe.ts';
