// Shared config loader consumed by every verb wiring that imports a
// `devstack.config.ts`. Returns the public stack handle exactly as the
// config exported it, plus the validated internal engine stack for CLI
// paths that need the erased runtime boundary shape.

import { Effect } from 'effect';

import {
	DEFAULT_CONFIG_PATH,
	loadDevstackConfig,
	resolveConfigPath,
	type DevstackConfigError,
} from '../../api/load-config.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';
import { CliConfigInvalidError, CliConfigNotFoundError } from '../../surfaces/cli/index.ts';

// Re-exported so existing CLI importers (`main.ts`, `snapshot.ts`) keep
// their `./config-loader` import site. The implementation lives in the
// CLI-free `api/load-config.ts` facade.
export { DEFAULT_CONFIG_PATH, resolveConfigPath };

/** Translate the CLI-free loader's failure into the CLI-flavored error
 *  union so command exit codes stay stable. */
const toCliError = (err: DevstackConfigError): CliConfigNotFoundError | CliConfigInvalidError =>
	err.kind === 'not-found'
		? new CliConfigNotFoundError({
				message: err.message,
				searchedPaths: err.searchedPaths ?? [],
			})
		: new CliConfigInvalidError({ message: err.message, cause: err.cause });

export interface ConfigLoader {
	readonly load: (
		configPath: string | undefined,
	) => Effect.Effect<LoadedConfig, CliConfigNotFoundError | CliConfigInvalidError>;
}

export const makeConfigLoader = (): ConfigLoader => ({
	load: (configPath) =>
		loadDevstackConfig(configPath).pipe(Effect.mapError(toCliError)) as Effect.Effect<
			LoadedConfig,
			CliConfigNotFoundError | CliConfigInvalidError
		>,
});
