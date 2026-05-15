// `localnetWalrusOptions(manifest)` — localnet-specific config inputs
// for `new WalrusClient(...)`. `packageConfig` is read from the
// manifest's `walrus` package's `captured` fields (populated by the
// `walrus()` plugin's register step); `storageNodeUrlScheme: 'http'`
// since devstack storage nodes serve plain HTTP.

interface ManifestShape {
	packages?: Array<{
		name: string;
		packageId: string;
		captured?: Record<string, unknown>;
	}>;
}

export interface LocalnetWalrusOptions {
	/** `systemObjectId` + `stakingPoolId` for `WalrusClient`. */
	packageConfig: { systemObjectId: string; stakingPoolId: string };
	/** Always `'http'` — devstack storage nodes serve plain HTTP. */
	storageNodeUrlScheme: 'http';
}

/**
 * Localnet-specific config inputs for `new WalrusClient(...)`.
 *
 *     const client = new WalrusClient({
 *       suiClient,
 *       ...localnetWalrusOptions(manifest),
 *       wasmUrl,
 *     });
 *
 * Throws if the manifest is empty or doesn't carry a `walrus` package.
 */
export function localnetWalrusOptions(manifest: unknown): LocalnetWalrusOptions {
	const m = manifest as ManifestShape;
	// The walrus plugin publishes its package under `<name>.walrus`
	// (default name `walrus`), so the manifest entry is `walrus.walrus`.
	// Tolerate the bare `walrus` name too for callers vendoring a manual
	// manifest.
	const walrusPkg =
		m.packages?.find((p) => p.name === 'walrus.walrus') ??
		m.packages?.find((p) => p.name === 'walrus');
	if (walrusPkg === undefined) {
		throw new Error(
			'localnetWalrusOptions: no `walrus.walrus` (or `walrus`) package in manifest. Has devstack finished bringing walrus up?',
		);
	}
	const systemObjectId = walrusPkg.captured?.systemObject;
	const stakingPoolId = walrusPkg.captured?.stakingObject;
	if (typeof systemObjectId !== 'string' || typeof stakingPoolId !== 'string') {
		throw new Error(
			'localnetWalrusOptions: walrus package missing systemObject/stakingObject in captured.',
		);
	}
	return {
		packageConfig: { systemObjectId, stakingPoolId },
		storageNodeUrlScheme: 'http',
	};
}
