// Wallet plugin — Codegenable contribution.
//
// Architecture (15-wallet.md §"Capabilities PRODUCED" + §"Codegen
// emits a `dapp-kit-config.ts`"):
//
//   - The browser-side dev-wallet adapter is the cross-boundary
//     consumer. It reads a typed `dapp-kit-config` value at startup,
//     constructs a `DevstackSignerAdapter`, and registers it with
//     `@mysten/dapp-kit`'s wallet-standard surface (in user-app
//     bundle code — devstack itself NEVER imports dapp-kit).
//
//   - The emitted file lives at `dapp-kit/config.ts` under the staging
//     dir. The generated module owns the exported config value's type.
//
// SENSITIVE FLAG (manifest-vs-token threat surface):
//
//   - The emitted file carries the unredacted pair URL (incl. the
//     `#token=<32-hex>` fragment) so the dev-wallet adapter can wire
//     itself up without a side-channel read.
//   - Therefore `sensitive: true`. The codegen orchestrator tightens
//     the file mode to `0o600` on emit AND injects the file path into
//     `.gitignore`.
//   - The token lives in a `0o600` side-channel file (see
//     `pairing.ts:tokenPath`) AND the codegen emit is `0o600` via the
//     sensitive flag. The unredacted pair URL is never written to a
//     world-readable manifest — only the tightened codegen file carries
//     it.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

import { defineSimpleConstExport } from '../internal/codegen-helpers.ts';

// ----------------------------------------------------------------------
// Emitted shape
// ----------------------------------------------------------------------

/** The typed shape `dapp-kit/config.ts` exports. Downstream consumers
 *  (the user-app's dapp-kit boot code) import and consume this.
 *
 *  Field shape mirrors what `DevstackSignerAdapter` needs:
 *
 *    - `walletUrl`     : the wallet HTTP server's URL (router-fronted
 *                        host form when available, direct-loopback
 *                        fallback otherwise).
 *    - `pairUrl`       : `walletUrl` + `/#token=<32-hex>` (single
 *                        source of truth for the token).
 *    - `protocolPaths` : path constants the adapter reads. Mirrored
 *                        here so the adapter doesn't depend on a
 *                        separate import.
 *    - `network`       : the network name the wallet's accounts are
 *                        scoped to (e.g. `localnet`). The dev wallet
 *                        derives the wallet-standard chain (`sui:<network>`)
 *                        from it at the wallet-standard boundary; devstack
 *                        itself never carries the `sui:`-prefixed form.
 */
export interface DevWalletConfig {
	readonly walletUrl: string;
	readonly pairUrl: string;
	readonly network: string;
	readonly protocolPaths: {
		readonly health: string;
		readonly accounts: string;
		readonly signTransaction: string;
		readonly signPersonalMessage: string;
	};
}

// ----------------------------------------------------------------------
// Decl construction
// ----------------------------------------------------------------------

/**
 * Construct the Codegenable contribution.
 *
 *  Emits `dapp-kit/config.ts` with `sensitive: true` → the orchestrator
 *  writes the file with `0o600` and gitignores it. The emitted shape
 *  carries the unredacted pair URL; the side-channel token file is
 *  also `0o600`.
 *
 *  The `resolved` arg is supplied AFTER acquire (the substrate's
 *  "resolve-once" memo). At factory time the barrel passes a
 *  placeholder so the type plumbing works; at codegen time the
 *  substrate re-evaluates with the resolved values.
 */
export const makeWalletCodegen = (resolved: DevWalletConfig): CodegenableDecl<'dapp-kit-config'> =>
	defineSimpleConstExport({
		emitterName: 'dapp-kit-config',
		outputPath: 'dev-wallet.ts',
		exportName: 'devWallet',
		value: resolved,
		// Dev-only + secret-bearing: lands in the gitignored
		// `generated-extras` tree (reached via `@devstack-dev`). The
		// token never enters the runtime `src/generated/` tree.
		outputLocation: 'generated-extras',
		// SENSITIVE: drives 0o600. The architecture has this hook
		// (`SnapshotableDecl` mirrors it for the snapshot subtree).
		// `generated-extras` is already gitignored at the `.devstack`
		// level, so the codegen `.gitignore` does not list it.
		sensitive: true,
	});
