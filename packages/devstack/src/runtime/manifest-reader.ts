// Manifest reader. Counterpart to manifest-writer.ts. Loads a prior
// per-network manifest (if present) and bulk-hydrates a Registry from
// it without dirtying the kinds — hydration is a state-restore, not a
// fresh registration, so Emit cascades shouldn't fire on it.
//
// Used by the one-shot deploy path (§10.1) so source actions see prior
// state in their `getStatus()` skip predicates: e.g. a Publish action
// whose recorded `packageId` is still live on chain can skip republish.

import { existsSync, readFileSync, statSync } from 'node:fs';
import type {
	Account,
	Network,
	Package,
	Registry,
	RegistryQuery,
	Service,
	Token,
} from '../core/types.js';
import type { RegistryImpl } from '../registry/index.js';
import { type Manifest, manifestPath } from './manifest-writer.js';

export interface ReadManifestOptions {
	appDir: string;
	stack: string;
	network: Network;
}

/** Soft cap on manifest file size. Real manifests are <100KB; anything
 * orders-of-magnitude larger is either a bug (a Publish action's
 * `captured` map blew up) or a hostile committed file. Refuse rather
 * than blocking the event loop on a multi-GB JSON.parse. */
const MANIFEST_MAX_BYTES = 50 * 1024 * 1024;

/** Returns the parsed manifest, or `null` if the file does not exist.
 * Throws when the manifest exceeds {@link MANIFEST_MAX_BYTES}. */
export function readManifest(opts: ReadManifestOptions): Manifest | null {
	const path = manifestPath(opts);
	if (!existsSync(path)) return null;
	const stat = statSync(path);
	if (stat.size > MANIFEST_MAX_BYTES) {
		throw new Error(
			`readManifest: ${path} is ${stat.size} bytes (cap ${MANIFEST_MAX_BYTES}). ` +
				'Real manifests are <100KB. If the file ballooned legitimately, raise the cap; ' +
				'if it was committed by mistake, regenerate via `devstack reset --yes && devstack up`.',
		);
	}
	const raw = readFileSync(path, 'utf8');
	return JSON.parse(raw) as Manifest;
}

export interface HydrateOptions {
	appDir: string;
	stack: string;
	network: Network;
	registry: Registry;
}

/**
 * Bulk-load a prior manifest into the given registry. Returns true if a
 * manifest was found and applied; false if no prior manifest existed.
 * Clears the dirty set after hydration so the cascade doesn't see hydrated
 * kinds as "freshly changed" — only actions that actually re-register
 * during the cycle should trigger Emit re-runs.
 */
export function hydrateRegistry(opts: HydrateOptions): boolean {
	const manifest = readManifest({ appDir: opts.appDir, stack: opts.stack, network: opts.network });
	if (manifest === null) return false;

	const reg = opts.registry;
	const r = manifest.registry;

	for (const t of (r.tokens ?? []) as Token[]) reg.tokens.register(t);
	for (const p of (r.packages ?? []) as Package[]) reg.packages.register(p);
	for (const a of (r.accounts ?? []) as Account[]) reg.accounts.register(a);
	for (const s of (r.services ?? []) as Service[]) reg.services.register(s);

	// Plugin-namespaced kinds are stored under top-level keys other than
	// the four core ones. Round-trip them through the namespace API.
	const coreKeys = new Set(['tokens', 'packages', 'accounts', 'services']);
	for (const [name, value] of Object.entries(r)) {
		if (coreKeys.has(name)) continue;
		const bag = value as Record<string, Array<{ name: string }>>;
		// Reach into the impl: ns<T>() returns a Proxy that auto-creates
		// query objects for any kind name accessed on it.
		const ns = (reg as RegistryImpl).ns<Record<string, RegistryQuery<{ name: string }>>>(name);
		for (const [kindName, items] of Object.entries(bag)) {
			const query = ns[kindName];
			if (query === undefined) continue;
			for (const item of items) query.register(item);
		}
	}

	(reg as RegistryImpl).flushDirty();
	return true;
}
