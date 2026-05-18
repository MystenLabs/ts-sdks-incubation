// Shared loader utilities for CLI subcommands.
//
// Three previously duplicated patterns are consolidated here:
//
//   1. `wrapCause(message, cause)` — wrap an arbitrary cause into a new
//      `Error` whose `.message` is a single-line summary AND whose `.cause`
//      retains the original tagged-error chain. The top-level `tapCause`
//      reporter in `cli/index.ts` walks `Error.cause` recursively so
//      structured errors (DockerError stderr, SuiError phase, …) are
//      surfaced verbatim instead of collapsing to the outer class name.
//
//   2. `loadConfigModule(configPath, validate)` — resolve a user config
//      path against CWD, fail fast with a clear error if the file is
//      missing (`fs.existsSync` guard runs BEFORE the dynamic import so the
//      user sees "config not found at /abs/path" instead of a Node ERR_MODULE_NOT_FOUND
//      stack trace), then dynamic-import the module and validate the
//      default export.
//
//   3. Two narrow validators for the two known config shapes:
//      - `requireLaunchEffect` for `devstack up`'s
//        `defineDevstack()`-returned handle (needs `.launchEffect()`)
//      - `requireLayer` for `devstack apply`'s scoped Layer.build path
//        (needs `.layer`)
//
// Before this consolidation, each subcommand reimplemented its own
// `wrapCause` + `loadDevstack`; the implementations drifted slightly
// (apply's path didn't include the `Error.withSpan` annotation, prune's
// didn't preserve `cause` at all). Anyone adding a new subcommand that
// loads a config now has one obvious place to import from.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Layer } from 'effect';
import { prettyError } from '../engine/pretty-error.js';
import type { RunOverrides } from '../engine/supervisor.js';

/** Wrap an arbitrary cause into a new `Error` with a single-line summary
 *  and the original cause preserved on `Error.cause` for the top-level
 *  `tapCause` reporter to walk. */
export const wrapCause = (message: string, cause: unknown): Error => {
	const err = new Error(`${message}: ${prettyError(cause).split('\n')[0]}`);
	(err as Error & { cause?: unknown }).cause = cause;
	return err;
};

/** Validator: the config's default export must expose `launchEffect`.
 *  Matches what `defineDevstack()` returns, consumed by `devstack up`. */
export interface DevstackLaunchable {
	launchEffect: (overrides?: RunOverrides) => Effect.Effect<void, unknown, never>;
}

export const requireLaunchEffect = (configPath: string, mod: unknown): DevstackLaunchable => {
	const d = (mod as { default?: unknown } | undefined)?.default as
		| Partial<DevstackLaunchable>
		| undefined;
	if (!d || typeof d.launchEffect !== 'function') {
		throw new Error(
			`${configPath} must default-export a DevstackHandle ` +
				`(from devstack(...) or defineDevstack)`,
		);
	}
	return d as DevstackLaunchable;
};

/** Validator: the config's default export must expose `layer`.
 *  Matches what `devstack(...)` / `defineDevstack()` expose for
 *  `Layer.build`-based callers like `devstack apply`. */
export interface DevstackLayered {
	layer: Layer.Layer<any, any, any>;
}

export const requireLayer = (configPath: string, mod: unknown): DevstackLayered => {
	const d = (mod as { default?: unknown } | undefined)?.default as
		| Partial<DevstackLayered>
		| undefined;
	if (!d || typeof d.layer === 'undefined') {
		throw new Error(
			`${configPath} must default-export a DevstackHandle ` +
				`(from devstack(...) or defineDevstack)`,
		);
	}
	return d as DevstackLayered;
};

/** Walk up from `cwd` looking for a `devstack.config.{ts,js,mjs}`. Stops
 *  at the first `package.json` encountered so a sibling app's parent
 *  config doesn't leak in. Returns the absolute path of the first config
 *  found, or `null` if no config exists at or above `cwd` before the
 *  workspace boundary. */
const CONFIG_BASENAMES: ReadonlyArray<string> = [
	'devstack.config.ts',
	'devstack.config.mts',
	'devstack.config.mjs',
	'devstack.config.js',
];

export const findConfigUp = (cwd: string): string | null => {
	let dir = resolvePath(cwd);
	for (;;) {
		for (const name of CONFIG_BASENAMES) {
			const candidate = joinPath(dir, name);
			if (existsSync(candidate)) return candidate;
		}
		// Stop at the FIRST package.json we encounter going up. Without
		// this guard, a workspace-root config would shadow a package's
		// own missing-config error with a config that wasn't authored
		// for the package — silent surprise. The package boundary IS
		// the workspace boundary for our purposes.
		if (existsSync(joinPath(dir, 'package.json'))) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};

/** Resolve a user config path against CWD, validate it exists on disk,
 *  dynamic-import it, and run the caller's `validate` over the resulting
 *  module. When `configPath` resolves to a non-existent file AND was the
 *  conventional default (`./devstack.config.ts`), walk up from CWD via
 *  `findConfigUp` so subcommands work from a subdir. Failures land on
 *  `Error.cause` so the top-level reporter can walk them. */
export const loadConfigModule = <T>(
	configPath: string,
	validate: (configPath: string, mod: unknown) => T,
): Effect.Effect<T, Error, never> =>
	Effect.gen(function* () {
		const absolute = resolveConfigPath(configPath);

		// `fs.existsSync` BEFORE the dynamic import — a missing file would
		// otherwise surface as a Node ERR_MODULE_NOT_FOUND with the
		// `file://` URL embedded in the message. The synchronous probe is
		// fast and gives the user a path-shaped error they can act on.
		if (absolute === null) {
			const attempted = resolvePath(process.cwd(), configPath);
			return yield* Effect.fail(
				new Error(
					`config not found at ${attempted} ` +
						`(resolved from \`${configPath}\` against cwd ${process.cwd()}; ` +
						`also walked up to the nearest package.json)`,
				),
			);
		}

		const url = pathToFileURL(absolute).href;
		const mod = yield* Effect.tryPromise({
			try: () => import(url) as Promise<unknown>,
			catch: (cause) => wrapCause(`failed to load ${configPath}`, cause),
		}).pipe(Effect.withSpan('cli.loadConfig', { attributes: { configPath: absolute } }));

		return yield* Effect.try({
			try: () => validate(absolute, mod),
			catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		});
	});

// Resolve `configPath` to an absolute file on disk, or null when the
// user-supplied path doesn't exist. Explicit paths (anything other than
// the conventional `./devstack.config.ts` default) are only ever
// resolved against CWD — the walk-up sweep is reserved for the
// default. Otherwise a `--config foo.ts` mistype would silently land on
// a workspace-root config the user didn't intend.
const DEFAULT_CONFIG_PATH = './devstack.config.ts';

const resolveConfigPath = (configPath: string): string | null => {
	const explicit = resolvePath(process.cwd(), configPath);
	if (existsSync(explicit)) return explicit;
	if (configPath !== DEFAULT_CONFIG_PATH) return null;
	if (isAbsolute(configPath)) return null;
	return findConfigUp(process.cwd());
};
