// Walrus plugin — Codegenable contribution.
//
// Architecture §6: plugins emit typed `CodegenableDecl`s; the codegen
// orchestrator stages files into the user's source tree WITHOUT
// naming the plugin. Walrus's contribution is the SDK-ready
// `packageConfig` shape that the `@mysten/walrus` SDK consumes —
// `{systemObjectId, stakingPoolId, exchangeIds}` — plus the proxy /
// aggregator / publisher URLs for HTTP consumers.
//
// The bindings are surfaced here as a typed `WalrusBindings` shape so
// downstream code can `import { walrus }` from the codegen-staged file
// and get a fully-typed handle.
//
// Mode-asymmetric emission:
//   - Local: emits `{packageConfig, proxyUrl, aggregatorUrl,
//     publisherUrl, nodes}` — full shape (all three URLs resolved).
//   - Known: emits the same shape; each of `proxyUrl /
//     aggregatorUrl / publisherUrl` is `string | null` and surfaces
//     INDEPENDENTLY — a field is null only when THAT specific URL is
//     unresolved. A missing publisher URL does not suppress an
//     available proxy/aggregator URL.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

/** Per-node descriptor — matches the storage-nodes module's shape
 *  for the local-cluster path, and is empty (or whatever the user
 *  provides) for known. */
export interface WalrusNodeBinding {
	readonly nodeIndex: number;
	readonly publicHostname: string;
	readonly rpcUrl: string;
}

/** The typed shape the emitted file exports. */
export interface WalrusBindings {
	readonly mode: 'local' | 'known';
	readonly chain: string;
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
	readonly walCoinType: string | null;
	/** SDK-ready `packageConfig` — structurally compatible with
	 *  `@mysten/walrus`'s `WalrusPackageConfig`. */
	readonly packageConfig: {
		readonly systemObjectId: string;
		readonly stakingPoolId: string;
		readonly exchangeIds?: ReadonlyArray<string>;
	};
	/** HTTP URLs — each is `null` only when that specific URL is
	 *  unresolved (local resolves all three; known surfaces each
	 *  independently — distilled-doc invariant 15). */
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	/** Storage-node committee — local publishes N descriptors; known
	 *  publishes user-supplied nodes (testnet/mainnet's 100+ nodes
	 *  are fetched dynamically by the SDK, not pinned here —
	 *  distilled-doc invariant 16). */
	readonly nodes: ReadonlyArray<WalrusNodeBinding>;
}

/** Inputs to the codegen contribution — supplied at acquire-time.
 *  The codegen orchestrator's resolve-once memo picks up the real
 *  values via the dynamic capability factory (same shape used by
 *  Sui + Account: the factory stamps placeholders at compose-time
 *  and the post-acquire factory restamps with resolved fields). */
export interface MakeCodegenableInputs {
	readonly mode: 'local' | 'known';
	readonly chain: string;
	readonly walrusPackageId: string | null;
	readonly walPackageId: string | null;
	readonly walCoinType: string | null;
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
	readonly exchangeIds: ReadonlyArray<string>;
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
	readonly nodes: ReadonlyArray<WalrusNodeBinding>;
}

/** Construct the Codegenable contribution. Emit is byte-deterministic
 *  on unchanged input (architecture: no mtime churn on no-op
 *  cycles). */
export const makeCodegenable = (
	inputs: MakeCodegenableInputs,
): CodegenableDecl<'walrus-network'> => ({
	kind: 'codegenable',
	emitterName: 'walrus-network',
	outputPath: 'walrus.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			const bindings: WalrusBindings = {
				mode: inputs.mode,
				chain: inputs.chain,
				walrusPackageId: inputs.walrusPackageId,
				walPackageId: inputs.walPackageId,
				walCoinType: inputs.walCoinType,
				packageConfig: {
					systemObjectId: inputs.systemObjectId,
					stakingPoolId: inputs.stakingPoolId,
					exchangeIds: inputs.exchangeIds.length > 0 ? inputs.exchangeIds : undefined,
				},
				proxyUrl: inputs.proxyUrl,
				aggregatorUrl: inputs.aggregatorUrl,
				publisherUrl: inputs.publisherUrl,
				nodes: inputs.nodes,
			};
			ctx.exportConst('walrus', bindings);
			return ctx.done();
		}),
});
