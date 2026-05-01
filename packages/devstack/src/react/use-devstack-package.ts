// `useDevstackPackage(name)` — returns a registered codegen module with
// every typed builder pre-bound to the live `packageId` from the
// manifest's `registry.packages` entry of the same name. Throws on
// missing package or missing module.

import { useMemo } from 'react';
import { bindPackage } from './bind-package.js';
import { useDevstackContext } from './provider.js';
import type { CodegenModule, DevstackPackageRegistry } from './types.js';

type RegisteredKey = keyof DevstackPackageRegistry;
type RegisteredModule<K> = K extends RegisteredKey ? DevstackPackageRegistry[K] : CodegenModule;

/**
 * Returns the codegen module for `name` with every typed builder
 * pre-bound to the live `packageId` from the manifest.
 *
 * Apps get fully-typed builders without per-call casts by augmenting
 * `DevstackPackageRegistry` (see `types.ts`). Without augmentation,
 * the return type widens to the generic `CodegenModule = Record<string,
 * unknown>` and call sites have to narrow.
 */
export function useDevstackPackage<N extends string>(name: N): RegisteredModule<N> {
	const { manifest, packages } = useDevstackContext();
	return useMemo(() => {
		const mod = packages[name];
		if (mod === undefined) {
			throw new Error(
				`useDevstackPackage('${name}'): no codegen module registered. Add it to ` +
					`<DevstackProvider packages={{ ${name}: <imported codegen module> }}>.`,
			);
		}
		if (manifest === null) {
			throw new Error(
				`useDevstackPackage('${name}'): no manifest yet — has \`pnpm localnet:up\` been run?`,
			);
		}
		const registryPackages =
			(manifest.registry as { packages?: Array<{ name: string; packageId: string }> }).packages ??
			[];
		const entry = registryPackages.find((p) => p.name === name);
		if (entry === undefined) {
			throw new Error(
				`useDevstackPackage('${name}'): package '${name}' is not deployed yet — ` +
					`run \`pnpm localnet:up\` (or \`pnpm apply\`) first. ` +
					`Available packages: ${registryPackages.map((p) => p.name).join(', ') || '(none)'}`,
			);
		}
		return bindPackage(mod, entry.packageId) as RegisteredModule<N>;
	}, [manifest, packages, name]);
}

/** Like `useDevstackPackage`, but returns `undefined` when the package
 * isn't deployed yet instead of throwing. Use to gracefully gate UI on
 * the pre-deploy state (e.g. show a "run pnpm localnet:up" hint). */
export function useDevstackPackageOptional<N extends string>(
	name: N,
): RegisteredModule<N> | undefined {
	const { manifest, packages } = useDevstackContext();
	return useMemo(() => {
		const mod = packages[name];
		if (mod === undefined || manifest === null) return undefined;
		const registryPackages =
			(manifest.registry as { packages?: Array<{ name: string; packageId: string }> }).packages ??
			[];
		const entry = registryPackages.find((p) => p.name === name);
		if (entry === undefined) return undefined;
		return bindPackage(mod, entry.packageId) as RegisteredModule<N>;
	}, [manifest, packages, name]);
}
