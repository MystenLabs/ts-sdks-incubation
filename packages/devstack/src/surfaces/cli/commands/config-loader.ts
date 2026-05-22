// Shared config-loader seam for CLI commands.

import type { Effect } from 'effect';

import type { CliConfigInvalidError, CliConfigNotFoundError } from '../errors.ts';

/** Config loader seam. The bin entry implements this against the
 *  resolved `configPath` (default `./devstack.config.ts`, walking up
 *  if not found). Returns a verified `Stack` value or a typed
 *  `CliConfig*` error. */
export interface ConfigLoader {
	readonly load: (
		configPath: string | undefined,
	) => Effect.Effect<LoadedConfig, CliConfigNotFoundError | CliConfigInvalidError>;
}

/** Minimum shape command surfaces need from a loaded config. */
export interface LoadedConfig {
	readonly stack: { readonly _tag: 'Stack' };
	readonly resolvedConfigPath: string;
}
