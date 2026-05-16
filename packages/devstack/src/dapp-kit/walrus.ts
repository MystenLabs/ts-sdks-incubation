// `localnetWalrusOptions(manifest)` — localnet-specific config inputs
// for `new WalrusClient(...)`. `packageConfig` is read from the
// manifest's `walrus` package's `captured` fields (populated by the
// `walrus()` plugin's register step); `storageNodeUrlScheme: 'http'`
// since devstack storage nodes serve plain HTTP.

/** v3-shape input — flat `packages` array. Kept around for one
 *  release while consumers migrate to v4. */
interface ManifestV3Shape {
	packages?: Array<{
		name: string;
		packageId: string;
		captured?: Record<string, unknown>;
	}>;
}

/** v4-shape input — `packages` is a record keyed by name. */
interface ManifestV4Shape {
	packages?: Record<string, { id: string; captured?: Record<string, unknown> }>;
}

/** Internal normalized view — `name → { id, captured }`. Either shape
 *  collapses into this for the walrus-lookup below. */
interface PackageView {
	readonly id: string;
	readonly captured?: Record<string, unknown>;
}

function lookupPackage(
	manifest: ManifestV3Shape | ManifestV4Shape,
	name: string,
): PackageView | undefined {
	const v4 = (manifest as ManifestV4Shape).packages;
	if (v4 !== undefined && !Array.isArray(v4)) return v4[name];
	const v3 = (manifest as ManifestV3Shape).packages;
	if (Array.isArray(v3)) {
		const entry = v3.find((p) => p.name === name);
		return entry !== undefined ? { id: entry.packageId, captured: entry.captured } : undefined;
	}
	return undefined;
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
	const m = manifest as ManifestV3Shape | ManifestV4Shape;
	// The walrus plugin publishes its package under `<name>.walrus`
	// (default name `walrus`), so the manifest entry is `walrus.walrus`.
	// Tolerate the bare `walrus` name too for callers vendoring a manual
	// manifest.
	const walrusPkg = lookupPackage(m, 'walrus.walrus') ?? lookupPackage(m, 'walrus');
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
