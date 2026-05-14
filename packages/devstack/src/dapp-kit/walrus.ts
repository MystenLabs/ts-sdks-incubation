// `localnetWalrusOptions(manifest)` — localnet-specific config inputs
// for `new WalrusClient(...)`. `packageConfig` is read from the
// manifest's `walrus` package's `captured` fields (populated by the
// `walrus()` plugin's register step); `storageNodeUrlScheme: 'http'`
// since devstack storage nodes serve plain HTTP.

interface ManifestShape {
	packages?: Array<{
		name: string;
		packageId: string;
		captured?: Record<string, string>;
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
	const walrusPkg = m.packages?.find((p) => p.name === 'walrus');
	if (walrusPkg === undefined) {
		throw new Error(
			'localnetWalrusOptions: no `walrus` package in manifest. Has devstack finished bringing walrus up?',
		);
	}
	const systemObjectId = walrusPkg.captured?.systemObject;
	const stakingPoolId = walrusPkg.captured?.stakingObject;
	if (systemObjectId === undefined || stakingPoolId === undefined) {
		throw new Error(
			'localnetWalrusOptions: walrus package missing systemObject/stakingObject in captured.',
		);
	}
	return {
		packageConfig: { systemObjectId, stakingPoolId },
		storageNodeUrlScheme: 'http',
	};
}
