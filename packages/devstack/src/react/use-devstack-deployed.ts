// `useDevstackDeployed` — derive the "is the stack ready" gate from
// the manifest registry. Replaces the per-app `isDeployed` constants
// the example apps each computed slightly differently.

import { useDevstackContext } from './provider.js';

export interface UseDevstackDeployedOptions {
	/** Require these package names to be present in the registry. When
	 * omitted, only the default checks (any account + any package) apply. */
	requirePackages?: ReadonlyArray<string>;
}

/**
 * Returns true when the manifest is loaded AND has at least one
 * registered account AND every package in `requirePackages` (if set)
 * is present. Apps gate their UI on this to avoid mounting hooks like
 * `useDevstackPackage` before the stack is ready.
 *
 * Without `requirePackages`, returns true as long as the manifest
 * carries at least one account and one package — a "stack is up at all"
 * check. Apps that depend on a specific deployed package should pass
 * its name to make the gate strict.
 */
export function useDevstackDeployed(opts: UseDevstackDeployedOptions = {}): boolean {
	const { manifest } = useDevstackContext();
	if (manifest === null) return false;
	const r = manifest.registry as {
		accounts?: Array<{ name: string }>;
		packages?: Array<{ name: string }>;
	};
	const accounts = r.accounts ?? [];
	const packages = r.packages ?? [];
	if (accounts.length === 0) return false;
	const required = opts.requirePackages ?? [];
	if (required.length === 0) return packages.length > 0;
	const have = new Set(packages.map((p) => p.name));
	return required.every((name) => have.has(name));
}
