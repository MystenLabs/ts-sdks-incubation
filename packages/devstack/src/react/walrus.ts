// Walrus integration helpers.
//
// `localnetWalrusOptions(manifest)` returns the localnet-specific
// `WalrusClient` config: `packageConfig` from the manifest and
// `storageNodeUrlScheme: 'http'`, since devstack disables TLS on the
// storage nodes (axum-server 0.8.0 self-signed-handshake panic on
// arm64-darwin) and `@mysten/walrus@>=1.1.7` lets callers opt out of
// the SDK's default `https://` prefix. On testnet/mainnet the same
// call site drops the spread.

interface DevstackManifestShape {
	registry?: {
		packages?: Array<{
			name: string;
			packageId: string;
			captured?: Record<string, string>;
		}>;
	};
}

export interface LocalnetWalrusOptions {
	/** `systemObjectId` + `stakingPoolId` for `WalrusClient`. Read from
	 * the manifest's `walrus` package `captured` fields. */
	packageConfig: { systemObjectId: string; stakingPoolId: string };
	/** Always `'http'` — devstack storage nodes serve plain HTTP. Spread
	 * into `new WalrusClient({ ... })`. */
	storageNodeUrlScheme: 'http';
}

/**
 * Localnet-specific config inputs for `new WalrusClient(...)`.
 *
 * Apps construct walrus directly:
 *
 *     const client = new WalrusClient({
 *       suiClient,
 *       ...localnetWalrusOptions(manifest),
 *       wasmUrl,  // app supplies its own wasm URL however it likes
 *     });
 *
 * Production code drops the spread and uses the SDK's built-in
 * defaults (or its own per-network overrides).
 *
 * Throws if the manifest is empty or doesn't carry a `walrus` package
 * — that means devstack hasn't brought walrus up yet.
 */
export function localnetWalrusOptions(manifest: unknown): LocalnetWalrusOptions {
	const m = manifest as DevstackManifestShape;
	const walrusPkg = m.registry?.packages?.find((p) => p.name === 'walrus');
	if (walrusPkg === undefined) {
		throw new Error(
			'localnetWalrusOptions: no `walrus` package in manifest. Has `devstack up` finished bringing walrus up?',
		);
	}
	const systemObjectId = walrusPkg.captured?.systemObject;
	const stakingPoolId = walrusPkg.captured?.stakingObject;
	if (systemObjectId === undefined || stakingPoolId === undefined) {
		throw new Error(
			'localnetWalrusOptions: walrus package missing systemObject/stakingObject in manifest.captured.',
		);
	}
	return {
		packageConfig: { systemObjectId, stakingPoolId },
		storageNodeUrlScheme: 'http',
	};
}
