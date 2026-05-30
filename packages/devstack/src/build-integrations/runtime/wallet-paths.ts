// Wallet wire-protocol read surface — L5 build-integrations bridge.
//
// Architecture (ARCHITECTURE.md § Layer table): L5 (build-integrations)
// MUST NOT import directly from L2 plugin code. The pure wire-protocol
// constants (paths, prefix gate, header/token literals, endpoint
// name/key) live in the name-blind contract `contracts/wallet-protocol.ts`;
// this module re-exports them so the substrate-side L5 surfaces
// (Playwright / vitest / conventional-routes) consume one stable read
// surface and a future re-layout of the wallet plugin doesn't ripple in.
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
	WALLET_ENDPOINT_NAME,
	WALLET_ENDPOINT_KEY,
} from '../../contracts/wallet-protocol.ts';
