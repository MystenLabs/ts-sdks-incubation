// Vite identity resolver — thin adapter over `runtime/discoverManifestPath`.
//
// The vite preset needs the `(app, stack, manifestPath)` triple at
// config-load time so it can:
//   - locate the supervisor's manifest (canonical path: `<cwd-walkup>/
//     .devstack/stacks/<stack>/manifest.json`),
//   - generate the cold-start hostname for `allowedHosts`,
//   - point the watcher's `ignored` glob at the on-disk state root.
//
// The manifest-path discovery is owned by `runtime/discoverManifestPath`
// (env + override + walk-up precedence, stack-scoped only). This module
// composes that with package.json-driven app-name resolution so cold-
// start (no manifest yet) still produces a usable triple. Stack
// selection stays explicit/env/main to match the supervisor-written
// default path; package metadata identifies the app, not the stack.

import { dirname, resolve } from 'node:path';

import { discoverManifestPath, DEFAULT_STATE_DIR, readAppName } from '../runtime/index.ts';
import { resolveBuildIntegrationStack } from '../runtime/discover.ts';
import { ViteIdentityResolutionError } from './errors.ts';

export interface ResolvedIdentity {
	readonly app: string;
	readonly stack: string;
	/** Absolute path to the `.devstack` state directory the watcher
	 *  should ignore. Resolved from the discovered manifest when
	 *  present; otherwise from `cwd / stateDir`. */
	readonly stateDir: string;
	/** Absolute path the integration EXPECTS the manifest to live at.
	 *  Matches the supervisor's write path: `<state>/stacks/<stack>/
	 *  manifest.json`. Always set, even when the file does not exist
	 *  yet (cold-start). */
	readonly manifestPath: string;
}

export interface DiscoverOptions {
	/** Resolution cwd. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Explicit app name. Overrides env + package.json walk-up. */
	readonly app?: string;
	/** Explicit stack name. Overrides `DEVSTACK_STACK`; otherwise
	 *  defaults to `main`. */
	readonly stack?: string;
	/** Explicit state-dir name. Overrides `DEVSTACK_STATE_DIR`. */
	readonly stateDir?: string;
}

/**
 * Resolve the `(app, stack, manifestPath)` triple. Throws
 * `ViteIdentityResolutionError` only when neither `appName` nor a
 * walkable `package.json` is reachable.
 */
export const discoverIdentity = (options: DiscoverOptions = {}): ResolvedIdentity => {
	const cwd = options.cwd ?? process.cwd();
	const stack = resolveBuildIntegrationStack(options.stack);
	const stateDirName = options.stateDir ?? process.env.DEVSTACK_STATE_DIR ?? DEFAULT_STATE_DIR;

	const discovered = discoverManifestPath({ cwd, stack, stateDir: stateDirName });

	const manifestPath = discovered ?? resolve(cwd, stateDirName, 'stacks', stack, 'manifest.json');
	const stateDir =
		discovered !== undefined ? dirname(dirname(dirname(discovered))) : resolve(cwd, stateDirName);

	const app = options.app ?? process.env.DEVSTACK_APP ?? readAppNameWalkup(cwd);
	if (app === undefined) {
		throw new ViteIdentityResolutionError({
			message:
				'Could not resolve the devstack app name. Pass `app` to ' +
				'`defineDevstackViteConfig`, set `DEVSTACK_APP`, or ensure ' +
				'a `package.json#name` is reachable by walking up from cwd.',
			cwd,
			hint:
				'The package.json walk-up un-scopes `@org/name` to `name`. ' +
				'If your vite.config.ts lives outside a package, pass `app` ' +
				'explicitly.',
		});
	}

	return { app, stack, stateDir, manifestPath };
};

/** Walk up from `cwd` to find the closest `package.json` and return
 *  its un-scoped `name` field. Returns `undefined` if no package.json
 *  is reachable. Bounded to 32 levels — defense against pathological
 *  symlink loops. */
const readAppNameWalkup = (cwd: string): string | undefined => {
	let dir = resolve(cwd);
	for (let i = 0; i < 32; i += 1) {
		const name = readAppName(dir);
		if (name !== undefined) return name;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
};
