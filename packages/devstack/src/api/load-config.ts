// CLI-free config loader. Resolves and imports a `devstack.config.ts`,
// validates its default-exported `Stack`, and returns the public stack
// handle plus the erased engine stack.
//
// This is the single source of truth for config path resolution +
// loading. The CLI wrapper (`cli/wirings/config-loader.ts`) re-exports
// `resolveConfigPath`/`DEFAULT_CONFIG_PATH` and translates this module's
// `DevstackConfigError` into the CLI-flavored `CliConfig*` errors.
//
// Why it lives under `api/` and avoids `cli/`/`surfaces/`: build
// integrations (the vitest `globalSetup`) need to load a config to boot
// a stack, but must NOT pull the CLI/TUI graph into their bundle. This
// module depends only on node built-ins, `effect`, and the api/substrate
// types.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Data, Effect } from 'effect';

import { readStackEngine, type Stack } from './define-devstack.ts';
import type { SupervisedStack } from '../substrate/runtime/index.ts';

export const DEFAULT_CONFIG_PATH = './devstack.config.ts';

/** Resolve a `--config <path>` argument to an absolute path, falling
 *  through to a parent-directory search when the default value is
 *  used. Returns `null` when no candidate exists. */
export const resolveConfigPath = (configPath: string | undefined): string | null => {
	const target = configPath ?? DEFAULT_CONFIG_PATH;
	const explicit = isAbsolute(target) ? target : resolvePath(process.cwd(), target);
	if (existsSync(explicit)) return explicit;
	if (configPath !== undefined && configPath !== DEFAULT_CONFIG_PATH) return null;
	let dir = process.cwd();
	for (;;) {
		const candidate = resolvePath(dir, 'devstack.config.ts');
		if (existsSync(candidate)) return candidate;
		const parent = resolvePath(dir, '..');
		if (parent === dir) return null;
		dir = parent;
	}
};

/** Typed failure of {@link loadDevstackConfig}. `kind` distinguishes a
 *  missing config from an invalid one so CLI wrappers can map it to the
 *  right exit code. */
export class DevstackConfigError extends Data.TaggedError('DevstackConfigError')<{
	readonly kind: 'not-found' | 'invalid';
	readonly message: string;
	readonly searchedPaths?: ReadonlyArray<string>;
	readonly cause?: unknown;
}> {}

export interface LoadedDevstackConfig {
	/** The public stack handle exactly as the config default-exported it
	 *  — the value to feed `runStack`. */
	readonly stack: Stack<SupervisedStack['members']>;
	/** The validated internal engine stack (erased runtime boundary
	 *  shape) — exposes `options.codegen`/`options.stateDir`. */
	readonly engine: SupervisedStack;
	/** Absolute path of the config file that was loaded. */
	readonly resolvedConfigPath: string;
}

const validate = (
	resolvedConfigPath: string,
	mod: { readonly default?: unknown },
): LoadedDevstackConfig => {
	const def = mod.default;
	if (def === null || typeof def !== 'object' || (def as { _tag?: unknown })._tag !== 'Stack') {
		throw new DevstackConfigError({
			kind: 'invalid',
			message: `config at ${resolvedConfigPath} does not default-export a Stack value (got _tag=${String((def as { _tag?: unknown })?._tag)})`,
		});
	}
	const publicStack = def as Stack<SupervisedStack['members']>;
	let engine: SupervisedStack;
	try {
		engine = readStackEngine(publicStack);
	} catch (cause) {
		throw new DevstackConfigError({
			kind: 'invalid',
			message: `config at ${resolvedConfigPath} default-exported an invalid Stack handle: ${cause instanceof Error ? cause.message : String(cause)}`,
			cause,
		});
	}
	return { stack: publicStack, engine, resolvedConfigPath };
};

/**
 * Resolve, import, and validate a `devstack.config.ts`. Returns the
 * public stack handle (for `runStack`) plus the engine stack and the
 * resolved config path. Fails with a {@link DevstackConfigError}.
 */
export const loadDevstackConfig = (
	configPath?: string,
): Effect.Effect<LoadedDevstackConfig, DevstackConfigError> =>
	Effect.gen(function* () {
		const abs = resolveConfigPath(configPath);
		if (abs === null) {
			const attempted =
				configPath !== undefined
					? resolvePath(process.cwd(), configPath)
					: resolvePath(process.cwd(), DEFAULT_CONFIG_PATH);
			return yield* Effect.fail(
				new DevstackConfigError({
					kind: 'not-found',
					message: `devstack config not found at ${attempted}`,
					searchedPaths: [attempted],
				}),
			);
		}
		const url = pathToFileURL(abs).href;
		const mod = yield* Effect.tryPromise({
			try: () => import(url) as Promise<{ readonly default?: unknown }>,
			catch: (cause) =>
				new DevstackConfigError({
					kind: 'invalid',
					message: `failed to import ${abs}: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				}),
		});
		return yield* Effect.try({
			try: () => validate(abs, mod),
			catch: (cause) =>
				cause instanceof DevstackConfigError
					? cause
					: new DevstackConfigError({
							kind: 'invalid',
							message: `invalid config at ${abs}`,
							cause,
						}),
		});
	});
