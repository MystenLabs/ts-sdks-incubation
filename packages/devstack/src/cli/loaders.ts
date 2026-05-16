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
import { resolve as resolvePath } from 'node:path';
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

/** Resolve a user config path against CWD, validate it exists on disk,
 *  dynamic-import it, and run the caller's `validate` over the resulting
 *  module. Failures land on `Error.cause` so the top-level reporter can
 *  walk them. */
export const loadConfigModule = <T>(
	configPath: string,
	validate: (configPath: string, mod: unknown) => T,
): Effect.Effect<T, Error, never> =>
	Effect.gen(function* () {
		const absolute = resolvePath(process.cwd(), configPath);

		// `fs.existsSync` BEFORE the dynamic import — a missing file would
		// otherwise surface as a Node ERR_MODULE_NOT_FOUND with the
		// `file://` URL embedded in the message. The synchronous probe is
		// fast and gives the user a path-shaped error they can act on.
		if (!existsSync(absolute)) {
			return yield* Effect.fail(
				new Error(
					`config not found at ${absolute} ` +
						`(resolved from \`${configPath}\` against cwd ${process.cwd()})`,
				),
			);
		}

		const url = pathToFileURL(absolute).href;
		const mod = yield* Effect.tryPromise({
			try: () => import(url) as Promise<unknown>,
			catch: (cause) => wrapCause(`failed to load ${configPath}`, cause),
		}).pipe(Effect.withSpan('cli.loadConfig', { attributes: { configPath } }));

		return yield* Effect.try({
			try: () => validate(configPath, mod),
			catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		});
	});
