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

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Network, Registry } from '../core/types.js';
import type { RegistryImpl } from '../registry/index.js';
import { stackDir } from './active-stack.js';
import type { Manifest, SerializedActionState, SerializedRegistry } from './manifest-types.js';

export type { Manifest, SerializedActionState, SerializedRegistry } from './manifest-types.js';

export interface WriteManifestOptions {
	appName: string;
	appDir: string;
	stack: string;
	network: Network;
	registry: Registry;
	/** Per-action state from `Reconciler.serializeState()`. Persists across
	 * processes so a fresh `devstack up` skips already-applied setup
	 * actions on hash match without rerunning their `getStatus` probe. */
	actionStates?: Record<string, SerializedActionState>;
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
		emittedAt: new Date().toISOString(),
		registry: serializeRegistry(reg),
		...(opts.actionStates !== undefined && Object.keys(opts.actionStates).length > 0
			? { actionStates: opts.actionStates }
			: {}),
	};
}

export function writeManifest(opts: WriteManifestOptions): string {
	const path = manifestPath({ appDir: opts.appDir, stack: opts.stack, network: opts.network });
	const manifest = buildManifest(opts);
	mkdirSync(dirname(path), { recursive: true });
	// Atomic write: stage to `.tmp`, then `rename` (POSIX-atomic on the same
	// filesystem). A `kill -9` between the two steps leaves the prior
	// manifest intact rather than a half-written file. Stays simple so it
	// stays correct.
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(manifest, jsonReplacer, '\t')}\n`, 'utf8');
	renameSync(tmp, path);
	return path;
}

function serializeRegistry(reg: RegistryImpl): SerializedRegistry {
	return reg.snapshot();
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	return value;
}
