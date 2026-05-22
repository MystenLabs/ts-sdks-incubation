// Sui plugin — barrel + factories.
//
// Architecture: Sui is the most-depended-on plugin in the stack.
// Every consumer (Account/Coin/Wallet/Faucet/Package; Walrus/Seal/
// Deepbook fork variants) reads its resolved `SuiClient` via the
// `SuiTag`. The factory at this file folds the four modes behind:
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
// them via `capabilities()`.

import { Effect } from 'effect';

import { capabilities } from '../../api/define-capabilities.ts';
import { defineModeNamespace } from '../../api/mode-narrowed-factory.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-authoring.ts';
import { defineTag } from '../../api/tag.ts';
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
import { StrategyRegistryService } from '../../substrate/runtime/strategy-registry/service.ts';
import { makeCodegenable, type SuiNetworkBindings } from './codegen.ts';
import type { SuiProbeKey } from './chain-probe.ts';
import { makeSnapshotable } from './snapshot.ts';
import { SEED_OBJECTS_CAPABILITY_KEY, type SeedObjectsAccumulator } from './seed-objects.ts';
import { bootSuiService } from './service.ts';
import { SUI_ERROR_TAGS } from './errors.ts';
import { makeSuiLocalRoutables } from './routable.ts';
import { faucetCapabilityKey } from '../faucet/dispatcher.ts';
import { suiLocalStrategy } from '../faucet/strategies/sui-local.ts';
import type { SuiClient } from './mode/shared.ts';
import { resolveAutoTickIntervalMs } from './auto-tick.ts';
import type {
	SuiExternalOptions,
	SuiForkOptions,
	SuiLiveOptions,
	SuiLocalOptions,
	SuiOptions,
} from './mode/spec.ts';
import { parseDevstackNetwork } from '../../api/inference-network.ts';

// ---------------------------------------------------------------------------
// Tag — the resolved value all consumers read
// ---------------------------------------------------------------------------

/** The Sui plugin's identity tag. Built once at this barrel and
 *  imported by every consumer (substrate constraint: tags are not
 *  passed as runtime values — they're imported constants).
 *
 *  Tag id: `'sui'` (singular). The plugin's substrate-level plugin
 *  key is the same string. */
export const SuiTag = defineTag<'sui', SuiClient>('sui', 'sui');
const suiErrorContributions = pluginErrorContributions(SUI_ERROR_TAGS);

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
		case 'fork':
			return { mode: 'fork', upstream: parsed.upstream };
	}
};

// ---------------------------------------------------------------------------
// Plugin construction (internal — used by sui() + suiFor())
// ---------------------------------------------------------------------------

const buildPlugin = (opts: SuiOptions) => {
	if (opts.mode === 'fork') resolveAutoTickIntervalMs(opts.autoTick);
	return defineNodePlugin({
		provides: SuiTag,
		consumes: [] as const,
		kind: 'leaf-long-running',
		rebootCost: 'heavy',
		acquire: () =>
			Effect.gen(function* () {
				// The substrate threads `ContainerRuntime` + `IdentityContext`
				// via the plugin runtime context; the supervisor provides
				// these before this body runs.
				const runtime = yield* ContainerRuntimeService;
				const identity = yield* IdentityContext;
				const portBroker = yield* PortBrokerService;
				const { resolved, client } = yield* bootSuiService(runtime, identity, portBroker, opts);

				const registry = yield* StrategyRegistryService;

				// Architecture §9: the chain-probe is constructed by the
				// owner of the chain (Sui, here). Register it on the
				// strategy registry under `chain-probe:<chainId>` so
				// downstream OnChainArtifactPublisher callers
				// (Package, Coin, Walrus deploy, Seal deploy, Deepbook
				// deploy) can pull a typed read surface for the live
				// chain without taking a hard import on Sui. The
				// registration is scope-bound — when sui's plugin scope
				// closes (selective restart, stack shutdown), the entry
				// is reaped.
				yield* registry.register(chainProbeCapabilityKey(client.chain), client.chainProbe, {
					autoMounted: true,
					priority: 0,
				});

				// Sui auto-registers its own faucet strategy at acquire time
				// (architecture: "Sui contributes its own faucet:request
				// strategy"). The registration is keyed by the resolved
				// chain id so the faucet dispatcher picks it up without
				// any cross-plugin import edge. Skipped when the resolved
				// mode is faucet-less (mainnet) or fork (handled by the
				// fork admin path, not HTTP).
				if (resolved.faucet !== undefined && resolved.mode !== 'fork') {
					yield* registry.register(
						faucetCapabilityKey(resolved.chain),
						suiLocalStrategy({ faucetUrl: resolved.faucet }),
						{ autoMounted: true, priority: 0 },
					);
				}

				return client;
			}),
		capabilities: (resolved, acquireCtx) => makePluginCapabilities(opts, resolved, acquireCtx),
		errorContributions: suiErrorContributions,
	});
};

/** Construct the capability tuple POST-acquire. Receives the resolved
 *  `SuiClient` + acquire context so decls can stamp REAL chain ids /
 *  rpc URLs into their fields instead of factory-time placeholders.
 *
 *  The StrategyContributor decls here are shape markers — the live
 *  strategies are registered on the `StrategyRegistry` inside the
 *  `acquire` body above (chain-probe + faucet). The decls carry the
 *  resolved capability key so the supervisor's sink dispatch sees
 *  the REAL chain id on `chain-probe:<id>`. */
const makePluginCapabilities = (
	opts: SuiOptions,
	resolved: SuiClient,
	acquireCtx: AcquireContext,
) => {
	const realChain = resolved.chain;
	const snap: SnapshotableDecl = makeSnapshotable(
		opts.mode,
		acquireCtx.identity.app,
		acquireCtx.identity.stack,
		realChain,
	);
	const codegen: CodegenableDecl<SuiNetworkBindings, 'sui-network'> = makeCodegenable({
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
		// The real probe is registered with the StrategyRegistry inside
		// `acquire`; this decl is a SHAPE marker carrying the resolved
		// capability key for the supervisor's sink dispatch.
		strategy: (resolved?.chainProbe ?? {
			get: () => Effect.succeed(null as never).pipe(Effect.map(() => null)) as never,
		}) as ChainProbe<SuiProbeKey>,
		autoMounted: true,
	};

	const fundsReadyContribution: StrategyContributorDecl<
		typeof FUNDS_READY_GATE_KEY,
		{
			readonly waitFundsReady: Effect.Effect<void>;
		}
	> = {
		kind: 'strategy-contributor',
		capabilityKey: FUNDS_READY_GATE_KEY,
		// Default: trivially-succeeding. The acquire body overrides
		// this with the mode-aware gate at boot.
		strategy: { waitFundsReady: Effect.void },
		autoMounted: true,
	};

	const seedObjectsContribution: StrategyContributorDecl<
		typeof SEED_OBJECTS_CAPABILITY_KEY,
		SeedObjectsAccumulator
	> = {
		kind: 'strategy-contributor',
		capabilityKey: SEED_OBJECTS_CAPABILITY_KEY,
		// Stub accumulator — replaced at acquire by a fresh one (the
		// plugin-instance-scoped fix from `seed-objects.ts`).
		strategy: {
			contribute: () => Effect.void,
			snapshot: Effect.succeed<ReadonlyArray<string>>([]),
		},
		autoMounted: true,
	};

	const localRoutables =
		opts.mode === 'local'
			? makeSuiLocalRoutables({
					containerName: `devstack-${acquireCtx.identity.app}-${acquireCtx.identity.stack}-sui-validator`,
					includeGraphql: true,
				})
			: [];

	return capabilities(
		snap,
		codegen,
		chainProbeContribution,
		fundsReadyContribution,
		seedObjectsContribution,
		...localRoutables,
	);
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
 *      sui.for(network).local({...})    // OK
 *      sui.for(network).fork({...})     // type error: 'fork' not in 'local' branch
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
export { SUI_ERROR_TAGS } from './errors.ts';

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
