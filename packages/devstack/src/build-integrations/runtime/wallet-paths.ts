// Wallet plugin protocol bridge — L5 read surface.
//
// Architecture (ARCHITECTURE.md § Layer table): L5 (build-integrations)
// MUST NOT import directly from L2 plugin code. The wallet plugin owns
// the wire-protocol constants (paths, endpoint name); this module is
// the substrate-side bridge consumers go through so a future re-layout
// of the wallet plugin doesn't ripple into Playwright/vitest surfaces.
//
// Why a re-export module rather than a manifest-extras lookup?
//
//   - The path constants are compile-time invariants tied to the
//     wallet's HTTP server implementation — they don't change per
//     supervise. A runtime-extras lookup would force the in-spec
//     helpers to defer URL minting until the manifest is on disk;
//     the constants are already pinned at build time.
//   - The endpoint-name constant IS published to the manifest under
//     `services[].endpointName`, but Playwright config-load runs
//     BEFORE the supervisor writes the manifest. The cold-start path
//     needs the same constant. This bridge keeps both branches honest.

export {
	WalletHttpPath,
	WALLET_PROTOCOL_PREFIX,
	WALLET_AUTH_HEADER,
	WALLET_BEARER_PREFIX,
	WALLET_TOKEN_FRAGMENT_KEY,
	WALLET_TOKEN_HEX_LENGTH,
	type WalletHttpPathValue,
} from '../../plugins/wallet/protocol.ts';

/**
 * Both the canonical endpoint name and the user-facing alias are
 * sourced from the wallet plugin so the alias <-> canonical pairing
 * stays in lockstep with the plugin's HTTP server. The L5 surface
 * (Playwright / vitest) and the conventional-routes table both consume
 * these constants — see `WALLET_ENDPOINT_ALIAS` in the wallet plugin
 * for the convention and `runtime/conventional-routes.ts`
 * `BUILT_IN_ENDPOINT_ALIASES` for the alias fold.
 */
export {
	WALLET_ENDPOINT_NAME,
	WALLET_ENDPOINT_ALIAS,
} from '../../plugins/wallet/routable.ts';
