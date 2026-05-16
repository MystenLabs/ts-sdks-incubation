// Locate the on-disk `manifest.json` written by the supervisor.
//
// Three callers used to hand-roll variants of this lookup:
//
//   - `playwright/web-server.ts` (sync, walks up from cwd, returns a
//     fallback path so the caller's read can surface a structured
//     ENOENT).
//   - `codegen/emitters/dapp-kit.ts` (async, accepted an explicit
//     override, did NOT walk up from cwd — a known minor bug).
//   - Future readers (vitest fixture, status / manifest CLI) that all
//     want the same precedence.
//
// One helper, one precedence ladder, one well-defined fail mode. The
// precedence:
//
//   1. `DEVSTACK_MANIFEST_PATH` env var (top-level escape hatch — wins
//      over everything, including explicit `override` arguments).
//   2. `override` argument (caller-explicit).
//   3. Walk up from `opts.cwd ?? process.cwd()`; at each directory,
//      check the stack-scoped path
//      `<state-dir>/stacks/<stack>/manifest.json` FIRST, then the
//      legacy-flat `<state-dir>/manifest.json`. Stack-scoped wins at
//      each level so a `DEVSTACK_STACK=test` reader doesn't pick up a
//      `main` stack's manifest that happened to have been written more
//      recently to the flat path.
//
// `state-dir` defaults to `process.env.DEVSTACK_STATE_DIR ?? '.devstack'`.
// `stack` defaults to `process.env.DEVSTACK_STACK ?? 'main'`.
//
// Sync because Playwright's config loader is sync and the codegen
// caller is happy to call a sync function inside its
// `Effect.tryPromise`. Filesystem syscalls in question are cheap
// `statSync`s; no measurable perf cost.
//
// Returns `undefined` on miss (the property the status / example-build
// callers rely on — "manifest is optional at runtime"). Pass
// `{ required: true }` to throw a clear "run `devstack up` first"
// error instead.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface DiscoverManifestPathOptions {
	/** Caller-supplied override path. Bypasses the walk-up but is itself
	 *  still validated to exist (so a stale override doesn't silently
	 *  return a non-existent path). Lower precedence than the
	 *  `DEVSTACK_MANIFEST_PATH` env var. */
	readonly override?: string;
	/** Starting directory for the walk-up. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Stack name. Defaults to `process.env.DEVSTACK_STACK ?? 'main'`. */
	readonly stack?: string;
	/** State-dir name (the `.devstack` directory). Defaults to
	 *  `process.env.DEVSTACK_STATE_DIR ?? '.devstack'`. Absolute paths
	 *  are honored — the walk-up degenerates into a single check in
	 *  that case. */
	readonly stateDir?: string;
	/** When `true`, throw a descriptive error if no manifest is found.
	 *  Default `false` — return `undefined` instead, preserving the
	 *  "manifest is optional at runtime" property for status / example
	 *  builds. */
	readonly required?: boolean;
}

/**
 * Find an existing devstack manifest on disk.
 *
 * Returns the absolute path of the first match per the precedence
 * documented at the top of this module, or `undefined` if no candidate
 * exists. Pass `{ required: true }` to throw a "run `devstack up`
 * first" error on miss instead of returning `undefined`.
 */
export function discoverManifestPath(opts: DiscoverManifestPathOptions = {}): string | undefined {
	const envOverride = process.env.DEVSTACK_MANIFEST_PATH;
	if (envOverride !== undefined && envOverride !== '') {
		const resolved = resolve(envOverride);
		if (existsSync(resolved)) return resolved;
		if (opts.required === true) {
			throw new Error(
				`devstack: DEVSTACK_MANIFEST_PATH points at ${resolved}, but no file exists there. ` +
					`Unset the env var or write the manifest first (run \`devstack up\`).`,
			);
		}
		return undefined;
	}
	if (opts.override !== undefined && opts.override !== '') {
		const resolved = resolve(opts.override);
		if (existsSync(resolved)) return resolved;
		if (opts.required === true) {
			throw new Error(
				`devstack: explicit manifest path ${resolved} does not exist. ` +
					`Write the manifest first (run \`devstack up\`).`,
			);
		}
		return undefined;
	}
	const stack = opts.stack ?? process.env.DEVSTACK_STACK ?? 'main';
	const stateDir = opts.stateDir ?? process.env.DEVSTACK_STATE_DIR ?? '.devstack';
	const startDir = opts.cwd ?? process.cwd();
	let dir = resolve(startDir);
	while (true) {
		// Stack-scoped FIRST so a concurrent `DEVSTACK_STACK=test` reader
		// doesn't pick up the legacy-flat `main` manifest a sibling stack
		// may have written more recently.
		const candidates = [
			join(dir, stateDir, 'stacks', stack, 'manifest.json'),
			join(dir, stateDir, 'manifest.json'),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (opts.required === true) {
		const expected = resolve(startDir, stateDir, 'manifest.json');
		throw new Error(
			`devstack: no manifest.json found walking up from ${startDir} ` +
				`(looked for ${stateDir}/stacks/${stack}/manifest.json and ${stateDir}/manifest.json ` +
				`at each level). Run \`devstack up\` (or \`devstack apply\`) — ` +
				`it writes the manifest to ${expected}.`,
		);
	}
	return undefined;
}
