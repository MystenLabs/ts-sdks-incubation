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
// SENSITIVE FLAG (task requirement #5 — manifest-vs-token threat
// surface):
//
//   - The emitted file carries the unredacted pair URL (incl. the
//     `#token=<32-hex>` fragment) so the dev-wallet adapter can wire
//     itself up without a side-channel read.
//   - Therefore `sensitive: true`. The codegen orchestrator tightens
//     the file mode to `0o600` on emit AND injects the file path into
//     `.gitignore`.
//
// Distilled-doc tension absorbed (15-wallet.md "Manifest carries
// unredacted pair URL while token file is 0o600 — pick one"):
//
//   We pick "tighten the emit perms". The token still lives in a
//   `0o600` side-channel file (see `pairing.ts:tokenPath`), AND the
//   codegen emit is also `0o600` via the sensitive flag. The legacy
//   `.devstack/manifest.json` write that left the pair URL world-
//   readable is GONE — the rewrite no longer emits an unredacted pair
//   URL into the manifest. Only the codegen file carries it, and that
//   file is tightened.
//
//   See the report's §"Architecture-doc revisions" for the
//   architecture-doc note that needs to land alongside this.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

import { redactToken } from './pairing.ts';
import { WalletSpans } from './spans.ts';

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
 *    - `chain`         : Sui chain id the wallet's accounts are
 *                        scoped to. Surfaced so dapp-kit can pin its
 *                        active chain.
 */
export interface DappKitConfigBindings {
	readonly walletUrl: string;
	readonly pairUrl: string;
	readonly chain: string;
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
export const makeWalletCodegen = (
	resolved: DappKitConfigBindings,
): CodegenableDecl<'dapp-kit-config'> => ({
	kind: 'codegenable',
	emitterName: 'dapp-kit-config',
	outputPath: 'dapp-kit/config.ts',
	// SENSITIVE: drives 0o600 + .gitignore. The architecture has this
	// hook (`SnapshotableDecl` mirrors it for the snapshot subtree).
	sensitive: true,
	emit: (ctx) =>
		Effect.gen(function* () {
			// Span annotation logs ONLY the redacted form — defense-in-
			// depth so any debug-mode span dump doesn't leak the token.
			yield* Effect.annotateCurrentSpan({
				[WalletSpans.codegenPairUrl]: redactToken(resolved.pairUrl),
				[WalletSpans.codegenWalletUrl]: resolved.walletUrl,
			});
			ctx.exportConst('dappKitConfig', resolved);
			return ctx.done();
		}),
});
