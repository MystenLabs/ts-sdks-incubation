// Shared config loader consumed by every verb wiring that imports a
// `devstack.config.ts`. Returns a `LoadedConfig` whose `stack` field
// is the validated `SupervisedStack` value.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Effect } from 'effect';

import { readStackEngine, type Stack } from '../../api/define-devstack.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';
import { CliConfigInvalidError, CliConfigNotFoundError } from '../../surfaces/cli/index.ts';
import type { SupervisedStack } from '../../substrate/runtime/index.ts';

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

interface RawConfigModule {
	readonly default?: unknown;
}

const validateStackModule = (
	resolvedConfigPath: string,
	mod: unknown,
): LoadedConfig & { readonly stack: SupervisedStack } => {
	const m = mod as RawConfigModule;
	const def = m.default;
	if (def === null || typeof def !== 'object' || (def as { _tag?: unknown })._tag !== 'Stack') {
		throw new CliConfigInvalidError({
			message: `config at ${resolvedConfigPath} does not default-export a Stack value (got _tag=${String((def as { _tag?: unknown })?._tag)})`,
		});
	}
	let stack: SupervisedStack;
	try {
		stack = readStackEngine(def as Stack<SupervisedStack['members']>);
	} catch (cause) {
		throw new CliConfigInvalidError({
			message: `config at ${resolvedConfigPath} default-exported an invalid Stack handle: ${cause instanceof Error ? cause.message : String(cause)}`,
		});
	}
	return {
		stack,
		resolvedConfigPath,
	};
};

export interface ConfigLoader {
	readonly load: (
		configPath: string | undefined,
	) => Effect.Effect<LoadedConfig, CliConfigNotFoundError | CliConfigInvalidError>;
}

export const makeConfigLoader = (): ConfigLoader => ({
	load: (configPath) =>
		Effect.gen(function* () {
			const abs = resolveConfigPath(configPath);
			if (abs === null) {
				const attempted =
					configPath !== undefined
						? resolvePath(process.cwd(), configPath)
						: resolvePath(process.cwd(), DEFAULT_CONFIG_PATH);
				return yield* Effect.fail(
					new CliConfigNotFoundError({
						message: `devstack config not found at ${attempted}`,
						searchedPaths: [attempted],
					}),
				);
			}
			const url = pathToFileURL(abs).href;
			const mod = yield* Effect.tryPromise({
				try: () => import(url) as Promise<unknown>,
				catch: (cause) =>
					new CliConfigInvalidError({
						message: `failed to import ${abs}: ${cause instanceof Error ? cause.message : String(cause)}`,
						cause,
					}),
			});
			return yield* Effect.try({
				try: () => validateStackModule(abs, mod),
				catch: (cause) =>
					cause instanceof CliConfigInvalidError
						? cause
						: new CliConfigInvalidError({
								message: `invalid config at ${abs}`,
								cause,
							}),
			});
		}) as Effect.Effect<LoadedConfig, CliConfigNotFoundError | CliConfigInvalidError>,
});
