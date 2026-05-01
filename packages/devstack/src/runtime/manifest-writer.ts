// Manifest writer. Serializes a registry snapshot to disk.
//
//   localnet: `<appDir>/.devstack/stacks/<stack>/manifest.json` — one
//             manifest per per-app named stack (default 'main').
//   testnet/mainnet: `<appDir>/.devstack/manifests/<network>.json` — keyed
//             by network only; stack is ignored for live-net deploys
//             (you don't run multiple testnets locally).
//
// The Manifest schema is the registry serialised + small bookkeeping
// fields (app, network, version, emittedAt). Plugin-namespaced kinds are
// written under `registry.<namespace>.<kind>`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Network, Registry } from '../core/types.js';
import type { RegistryImpl } from '../registry/index.js';
import { stackDir } from './active-stack.js';
import type { Manifest, SerializedRegistry } from './manifest-types.js';

export type { Manifest, ManifestVersion, SerializedRegistry } from './manifest-types.js';

export interface WriteManifestOptions {
	appName: string;
	appDir: string;
	stack: string;
	network: Network;
	registry: Registry;
}

export interface ManifestPathOptions {
	appDir: string;
	stack: string;
	network: Network;
}

/**
 * Resolve the manifest file location for the given (stack, network).
 *
 *   localnet → `<appDir>/.devstack/stacks/<stack>/manifest.json`
 *   testnet/mainnet → `<appDir>/.devstack/manifests/<network>.json`
 *
 * Live-network manifests intentionally ignore `stack` — there's only one
 * `testnet` to deploy to from a given app, so a stack dimension would be
 * confusing. Stacks are a localnet-only concept.
 */
export function manifestPath(opts: ManifestPathOptions): string {
	if (opts.network === 'localnet') {
		return resolve(stackDir(opts.appDir, opts.stack), 'manifest.json');
	}
	return resolve(opts.appDir, '.devstack', 'manifests', `${opts.network}.json`);
}

export function buildManifest(opts: WriteManifestOptions): Manifest {
	const reg = opts.registry as RegistryImpl;
	return {
		app: opts.appName,
		network: opts.network,
		version: 2,
		emittedAt: new Date().toISOString(),
		registry: serializeRegistry(reg),
	};
}

export function writeManifest(opts: WriteManifestOptions): string {
	const path = manifestPath({ appDir: opts.appDir, stack: opts.stack, network: opts.network });
	const manifest = buildManifest(opts);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(manifest, jsonReplacer, '\t')}\n`, 'utf8');
	return path;
}

function serializeRegistry(reg: RegistryImpl): SerializedRegistry {
	const out: SerializedRegistry = {
		tokens: reg.tokens.list(),
		packages: reg.packages.list(),
		accounts: reg.accounts.list(),
		services: reg.services.list(),
	};
	// Namespaced kinds are stored on the RegistryImpl's internal Map; we
	// reach in via a typed accessor rather than a Proxy round-trip. Keep
	// the cast scoped here.
	const internalNamespaces = (
		reg as unknown as { namespaces: Map<string, Record<string, { list(): unknown[] }>> }
	).namespaces;
	for (const [name, kinds] of internalNamespaces) {
		const bag: Record<string, unknown[]> = {};
		for (const [kindName, query] of Object.entries(kinds)) {
			bag[kindName] = query.list();
		}
		out[name] = bag;
	}
	return out;
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	return value;
}
