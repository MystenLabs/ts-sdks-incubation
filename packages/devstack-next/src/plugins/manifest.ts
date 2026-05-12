import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Dep } from '../engine/types.js';
import { define } from '../factories/define.js';
import type { Account, Coin, Endpoint, Package } from '../shapes/index.js';

export interface ManifestOptions {
	/** Output path relative to `env.appDir` (or absolute).
	 * Default: `src/generated/manifest.ts`. */
	output?: string;
	/** Logical name. Default: `manifest`. Override when an app needs
	 * multiple manifest emissions (rare). */
	name?: string;
	/** Packages to project into the manifest. Each Dep returns a Package
	 * shape; emission order matches array order. `Dep<any, …>` lets
	 * callers pass parameterized Deps (e.g. `pool.get('account', {name})`)
	 * without wrapping. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	packages?: Dep<any, Package>[];
	/** Endpoints (RPC URLs, faucets, walrus nodes, …). Each entry can
	 *  return either a single Endpoint or an Endpoint[] — `walrus.appNetwork`
	 *  for example projects every storage node through one Dep, while
	 *  `sui.endpoint` returns a single shape. The renderer flattens both
	 *  forms before deduping by name. */
	endpoints?: Array<
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		Dep<any, Endpoint> | Dep<any, Endpoint[]>
	>;
	/** Accounts (signer addresses keyed by logical name). */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	accounts?: Dep<any, Account>[];
	/** Coins registered via `registerCoin` (fully-qualified Move type +
	 * decimals). The dev-wallet's faucet panel discovers mintable
	 * tokens through this list. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	coins?: Dep<any, Coin>[];
	/** App-specific extras — arbitrary serializable values keyed by name.
	 * The manifest renders them under a top-level `extras` field, so apps
	 * can stash on-chain objects, addresses, or other non-standard data
	 * the frontend needs without extending the core shape. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	extras?: Record<string, Dep<any, unknown>>;
}

export interface ManifestState {
	outputPath: string;
	contentHash: string;
}

interface ManifestDeps {
	packages: Package[];
	/** Pre-flatten shape — each entry is a single Endpoint or an array
	 *  of them (`walrus.appNetwork` projects every node through one
	 *  Dep). `renderManifest` flattens before deduping. */
	endpoints: Array<Endpoint | Endpoint[]>;
	accounts: Account[];
	coins: Coin[];
	extras: Record<string, unknown>;
}

// `manifest` emits a typed manifest TypeScript file under `<appDir>/<output>`.
// The file re-projects upstream Dep values so app code can `import { manifest }`
// without re-typing the four registry-style categories at every call site.
// Move bindings live in a separate `bindings` plugin — this plugin owns
// only the small, stable manifest projection.
//
// Cross-plugin fan-in works via `deps: { packages: [...], endpoints: [...] }`
// — each array's items are Deps. The engine walks the structure, resolves
// each Dep to its projected shape, and hands `run()` a flat object:
// `deps.packages: Package[]`, etc. Re-fires whenever any upstream's
// identity changes (input-hash includes resolved deps).
//
// `getStatus` returns ok when the on-disk file matches what we'd emit, so
// re-runs after a no-op restart skip the write (and the Vite HMR churn it
// would otherwise cause).
export function manifest(opts: ManifestOptions = {}) {
	const output = opts.output ?? 'src/generated/manifest.ts';
	const name = opts.name ?? 'manifest';

	const deps = {
		packages: opts.packages ?? [],
		endpoints: opts.endpoints ?? [],
		accounts: opts.accounts ?? [],
		coins: opts.coins ?? [],
		extras: opts.extras ?? {},
	};

	return define<ManifestState, {}, typeof deps>({
		name,
		deps,
		inputs: ({ deps }) => ({
			output,
			body: renderManifest(deps),
		}),
		getStatus: async ({ env, deps }) => {
			const path = resolveOutput(env.appDir, output);
			const expected = renderManifest(deps);
			try {
				const actual = await readFile(path, 'utf8');
				return { ok: actual === expected };
			} catch {
				return { ok: false };
			}
		},
		run: async ({ env, deps, prior }) => {
			const path = resolveOutput(env.appDir, output);
			const body = renderManifest(deps);
			const contentHash = hashOf(body);
			// Skip the write if the file already matches. Costs one
			// stat+read per cycle but keeps Vite HMR quiet on no-op
			// re-runs (and the file mtime stable, useful for downstream
			// staleness checks).
			let existing: string | undefined;
			try {
				existing = await readFile(path, 'utf8');
			} catch {
				// fall through — file missing, write fresh
			}
			if (existing !== body) {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, body, 'utf8');
			}
			// JSON sidecar alongside the TS — same content, different
			// extension. Lets out-of-process tools (Playwright spec
			// files, ad-hoc scripts) read the manifest without an ESM
			// loader for TypeScript. Written into the per-stack runtime
			// dir, not next to the TS — the TS goes into the app's
			// source tree for typed imports; the JSON belongs with the
			// rest of the runtime state.
			const stackDir = join(env.appDir, '.devstack', 'stacks', env.stack ?? 'main');
			const jsonPath = join(stackDir, 'manifest.json');
			const jsonBody = `${JSON.stringify(manifestData(deps), null, '\t')}\n`;
			let existingJson: string | undefined;
			try {
				existingJson = await readFile(jsonPath, 'utf8');
			} catch {
				// fall through
			}
			if (existingJson !== jsonBody) {
				await mkdir(stackDir, { recursive: true });
				await writeFile(jsonPath, jsonBody, 'utf8');
			}
			if (existing === body) {
				return prior ?? { outputPath: path, contentHash };
			}
			return { outputPath: path, contentHash };
		},
	});
}

function resolveOutput(appDir: string, output: string): string {
	return isAbsolute(output) ? output : resolve(appDir, output);
}

/** Dedupe + sort + strip the dep records into the manifest's
 *  canonical on-the-wire shape. Shared between the TS emitter and
 *  the JSON sidecar so both formats stay byte-for-byte equivalent
 *  modulo the TS preamble. */
export function manifestData(deps: ManifestDeps): {
	packages: Package[];
	endpoints: Endpoint[];
	accounts: Account[];
	coins: Coin[];
	extras: Record<string, unknown>;
} {
	const flatEndpoints: Endpoint[] = deps.endpoints.flatMap((e) => (Array.isArray(e) ? e : [e]));
	return {
		packages: dedupeAndSort(deps.packages, (p) => p.name).map(stripHostFields),
		endpoints: dedupeAndSort(flatEndpoints, (e) => e.name),
		accounts: dedupeAndSort(deps.accounts, (a) => a.name),
		coins: dedupeAndSort(deps.coins, (c) => c.name),
		extras: sortObjectKeys(deps.extras),
	};
}

// Emitted file body. Stable shape — sort keys, sort entries — so diffs
// only show when actual content changes.
export function renderManifest(deps: ManifestDeps): string {
	const sorted = manifestData(deps);
	const json = JSON.stringify(sorted, null, '\t');
	return `// AUTO-GENERATED by @mysten-incubation/devstack-next manifest — do not edit.
// Re-emitted whenever any upstream package / endpoint / account / coin / extra changes.

import type { Account, Coin, Endpoint, Package } from '@mysten-incubation/devstack-next/shapes';

export interface Manifest {
\tpackages: Package[];
\tendpoints: Endpoint[];
\taccounts: Account[];
\tcoins: Coin[];
\textras: Record<string, unknown>;
}

export const manifest: Manifest = ${json};
`;
}

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj).sort()) out[key] = obj[key];
	return out;
}

// Drop host-only fields from Package before serialization. The `path`
// field is an absolute on-host filesystem location used by the
// in-process bindings runtime; baking it into the committed manifest
// would leak one developer's home dir into every other developer's diff
// (and is meaningless after `git clone` to a different machine anyway).
function stripHostFields(pkg: Package): Package {
	if (pkg.path === undefined) return pkg;
	const { path: _path, ...rest } = pkg;
	return rest;
}

function dedupeAndSort<T>(items: T[], keyFn: (item: T) => string): T[] {
	const map = new Map<string, T>();
	for (const item of items) map.set(keyFn(item), item);
	return [...map.values()].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

// FNV-1a 32-bit. Cheap, deterministic, no crypto dep — fine for
// content-equality short-circuiting.
function hashOf(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
