// Manifest reader. Counterpart to manifest-writer.ts. Loads a prior
// per-network manifest (if present) and bulk-hydrates a Registry from
// it without dirtying the kinds — hydration is a state-restore, not a
// fresh registration, so Emit cascades shouldn't fire on it.
//
// Used by the one-shot deploy path (§10.1) so source actions see prior
// state in their `getStatus()` skip predicates: e.g. a Publish action
// whose recorded `packageId` is still live on chain can skip republish.

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Account, Network, Package, Registry, Service } from '../core/types.js';
import type { InternalRegistry } from '../registry/index.js';
import type { Manifest, SerializedActionState } from './manifest-types.js';
import { manifestPath } from './manifest-writer.js';

interface ReadManifestOptions {
	appDir: string;
	stack: string;
	network: Network;
}

/** Thrown by {@link hydrateRegistry} when the persisted manifest's
 * `app` field doesn't match the current `appName`. Surfaces a clean,
 * actionable stderr message in the CLI try/catch instead of a stack
 * trace — the user knows which manifest is offending, what the old
 * app name was, what the new one is, and how to recover.
 *
 * Cold-start safety: without this guard, a renamed `app:` would
 * silently hydrate the new run's registry with the old app's
 * `packageId`s, addresses, and reconciler hashes. Setup actions
 * would then skip on input-hash matches against the wrong app's
 * persisted hashes — the worst kind of stale state, since it's
 * invisible until something downstream blows up referencing a
 * package that doesn't exist on this app's chain. */
export class ManifestAppMismatchError extends Error {
	constructor(
		readonly manifestPath: string,
		readonly manifestApp: string,
		readonly currentApp: string,
	) {
		super(
			`manifest at ${manifestPath} was emitted for app '${manifestApp}'; ` +
				`current devstack.config.ts has app: '${currentApp}'.\n` +
				'Run `devstack wipe --yes` to clear the stale state and start fresh.',
		);
		this.name = 'ManifestAppMismatchError';
	}
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
				'if it was committed by mistake, regenerate via `devstack wipe --yes && devstack up`.',
		);
	}
	const raw = readFileSync(path, 'utf8');
	try {
		return JSON.parse(raw) as Manifest;
	} catch (err) {
		throw new Error(
			`readManifest: ${path} is corrupt (${err instanceof Error ? err.message : 'invalid JSON'}). ` +
				'Run `devstack wipe --yes` to wipe the stack and regenerate, or hand-fix the file.',
		);
	}
}

interface HydrateOptions {
	appName: string;
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
 *
 * Throws {@link ManifestAppMismatchError} when the persisted manifest's
 * `app` field doesn't match `opts.appName`. Without this guard, a
 * renamed `app:` would silently hydrate the new run with the old app's
 * persisted state.
 */
export function hydrateRegistry(opts: HydrateOptions): boolean {
	const manifest = readManifest({ appDir: opts.appDir, stack: opts.stack, network: opts.network });
	if (manifest === null) return false;

	if (manifest.app !== opts.appName) {
		throw new ManifestAppMismatchError(
			manifestPath({ appDir: opts.appDir, stack: opts.stack, network: opts.network }),
			manifest.app,
			opts.appName,
		);
	}

	const reg = opts.registry;
	const r = manifest.registry;

	for (const p of (r.packages ?? []) as Package[]) reg.packages.register(p);
	for (const a of (r.accounts ?? []) as Account[]) reg.accounts.register(a);
	for (const s of (r.services ?? []) as Service[]) reg.services.register(s);

	// Plugin-namespaced kinds are stored under top-level keys other than
	// the three core ones. Round-trip them through `getOrCreateKind`. The
	// `coin.tokens` entries flow through this path now that `tokens` is
	// no longer a core kind.
	const coreKeys = new Set(['packages', 'accounts', 'services']);
	for (const [name, value] of Object.entries(r)) {
		if (coreKeys.has(name)) continue;
		const bag = value as Record<string, Array<{ name: string }>>;
		const internal = reg as InternalRegistry;
		for (const [kindName, items] of Object.entries(bag)) {
			const query = internal.getOrCreateKind(name, kindName);
			for (const item of items) query.register(item);
		}
	}

	(reg as InternalRegistry).flushDirty();
	return true;
}

/** Read the persisted reconciler state from the manifest, if any. Returns
 * an empty record when no manifest exists or when the manifest predates
 * the schema bump that introduced `actionStates`. The returned record is
 * fed into `new Reconciler({ priorState })` so a fresh process can skip
 * setup actions on input-hash match without rerunning getStatus.
 *
 * Lives next to `hydrateRegistry` so the supervisor / one-shot driver
 * can call both at startup; they share the same manifest read. */
export function readReconcilerState(opts: ReadManifestOptions): Record<string, SerializedActionState> {
	const manifest = readManifestSafe(opts);
	if (manifest === null) return {};
	const states = manifest.actionStates;
	if (states === undefined) return {};
	const out: Record<string, SerializedActionState> = {};
	for (const [name, entry] of Object.entries(states)) {
		// Defensive: tolerate hand-edited manifests with the wrong shape.
		if (entry === null || typeof entry !== 'object') continue;
		if (typeof (entry as SerializedActionState).lastInputHash !== 'string') continue;
		out[name] = entry as SerializedActionState;
	}
	return out;
}

function readManifestSafe(opts: ReadManifestOptions): Manifest | null {
	try {
		return readManifest(opts);
	} catch {
		return null;
	}
}
