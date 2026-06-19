// Wallet plugin — Codegenable contribution.
//
// Architecture (15-wallet.md §"Capabilities PRODUCED"):
//
//   - The browser-side dev-wallet adapter is the cross-boundary
//     consumer. It reads the dev-wallet CONNECTION metadata (server
//     URL, network, protocol paths) at startup, constructs a
//     `DevstackSignerAdapter`, and registers it with `@mysten/dapp-kit`'s
//     wallet-standard surface (in user-app bundle code — devstack itself
//     NEVER imports dapp-kit).
//
//   - The connection metadata rides the deployment ENVELOPE's generic
//     `values['dev-wallet']` channel (NOT a generated file): boot's
//     `assembleDeployment` folds this decl's `idConfigValues` into
//     `deployment.networks[net].values['dev-wallet']`, which the Vite
//     plugin reads (`optionalValue(dep, 'dev-wallet', …)`) to assemble
//     the dev-wallet injection. The decl emits NO standalone file — it
//     is a values-only contribution.
//
// SECRET TOKEN (manifest-vs-token threat surface):
//
//   - The pairing token is NEVER routed through `values` (which lands in
//     the world-readable `deployment.json`). It stays in its `0o600`
//     side-channel file (see `pairing.ts:tokenPath`); the Vite `load`
//     hook runs in Node and reads it by path. Only the NON-secret
//     connection fields (`walletUrl`, `network`, `protocolPaths`) ride
//     `values`.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

import { defineSimpleConstExport } from '../internal/codegen-helpers.ts';

// ----------------------------------------------------------------------
// Connection metadata shape
// ----------------------------------------------------------------------

/** The NON-secret dev-wallet connection metadata the adapter needs to
 *  reach the in-process wallet HTTP server. Routed through the deployment
 *  envelope's `values['dev-wallet']` channel — NEVER a generated file, and
 *  NEVER the secret token (that stays in the `0o600` side-channel).
 *
 *    - `walletUrl`     : the wallet HTTP server's URL (router-fronted
 *                        host form when available, direct-loopback
 *                        fallback otherwise).
 *    - `network`       : the network name the wallet's accounts are
 *                        scoped to (e.g. `localnet`). The dev wallet
 *                        derives the wallet-standard chain (`sui:<network>`)
 *                        from it at the wallet-standard boundary; devstack
 *                        itself never carries the `sui:`-prefixed form.
 *    - `protocolPaths` : path constants the adapter reads. Mirrored here
 *                        so the adapter doesn't depend on a separate import.
 */
export interface DevWalletConnection {
	readonly walletUrl: string;
	readonly network: string;
	readonly protocolPaths: {
		readonly health: string;
		readonly accounts: string;
		readonly signTransaction: string;
		readonly signPersonalMessage: string;
	};
}

/** The deployment-values namespace + key the dev-wallet connection rides.
 *  Shared between the producer (this decl's `idConfigValues`) and the
 *  Vite plugin's `optionalValue(dep, DEV_WALLET_VALUES_NAMESPACE,
 *  DEV_WALLET_VALUES_KEY)` reader so the two can never drift. */
export const DEV_WALLET_VALUES_NAMESPACE = 'dev-wallet' as const;
export const DEV_WALLET_VALUES_KEY = 'connection' as const;

// ----------------------------------------------------------------------
// Decl construction
// ----------------------------------------------------------------------

/**
 * Construct the Codegenable contribution.
 *
 *  Values-only: emits NO standalone file. It carries the non-secret
 *  dev-wallet connection metadata through `aggregate.idConfigValues`, which
 *  boot's `assembleDeployment` folds into the deployment envelope's
 *  `values['dev-wallet'].connection`. The secret token is never routed here
 *  — it stays in the `0o600` side-channel file (`pairing.ts:tokenPath`).
 */
export const makeWalletCodegen = (
	connection: DevWalletConnection,
): CodegenableDecl<'dev-wallet-connection'> =>
	defineSimpleConstExport({
		emitterName: 'dev-wallet-connection',
		// Never written: `aggregateOnly` skips the standalone file, and the
		// aggregate carries ONLY `idConfigValues` (no `bucket` file emit at
		// `assembleDeployment`, which special-cases `config.ts` / `accounts.ts`).
		outputPath: 'dev-wallet.ts',
		exportName: 'devWallet',
		value: connection,
		aggregateOnly: true,
		aggregate: {
			// A neutral bucket name: `assembleDeployment` only PROJECTS the
			// `config.ts` / `accounts.ts` buckets into the typed deployment
			// fields; every other bucket contributes via `idConfigValues` only.
			// The committed-tree emit cycle never sees this decl (boot emits
			// only the STATIC id-free contributions + the deployment file).
			bucket: 'dev-wallet.ts',
			kind: 'dev-wallet',
			// Pass-through: the connection rides `idConfigValues`, so the
			// projection contributes nothing to a file bucket.
			project: () => null,
			// The non-secret connection metadata folded into the deployment
			// envelope's `values['dev-wallet'].connection` by `assembleDeployment`.
			idConfigValues: {
				[DEV_WALLET_VALUES_NAMESPACE]: {
					[DEV_WALLET_VALUES_KEY]: connection,
				},
			},
		},
	});
