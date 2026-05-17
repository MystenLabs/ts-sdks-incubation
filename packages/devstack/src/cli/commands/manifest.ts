// `devstack manifest` — print the current devstack manifest.json.
// Default: human-readable summary (endpoints / packages / accounts / coins
// / extras), mirroring the `status` command's shape. `--json` emits the
// raw JSON unchanged. `--path` overrides the discovered path.
//
// Read-only — does NOT build any layers, so it's safe against a live stack.
//
// Path resolution: routes through `discoverManifestPath()` so the
// `DEVSTACK_MANIFEST_PATH` env var, `DEVSTACK_STACK`, and walk-up from cwd
// are all honored — matching how the runtime / playwright fixtures find
// the same file. The supervisor writes to
// `<stateDir>/stacks/<stack>/manifest.json`, never the legacy flat path.

import { Console, Effect, FileSystem, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { resolve as resolvePath } from 'node:path';
import { discoverManifestPath } from '../../runtime/discover-manifest.js';

// Read env at action-time so a test that sets it via `process.env` after
// module-load (or a `.env` loader, or a fixture shell wrapper) sees the
// override. Resolving once at module-eval freezes whatever was set at the
// moment the CLI was imported.
const stateDir = (): string => process.env.DEVSTACK_STATE_DIR ?? '.devstack';
const stackName = (): string => process.env.DEVSTACK_STACK ?? 'main';
const defaultManifestPath = (): string =>
	discoverManifestPath() ?? `${stateDir()}/stacks/${stackName()}/manifest.json`;

interface ManifestSummary {
	readonly packages?: ReadonlyArray<{ name: string; packageId: string }>;
	readonly endpoints?: ReadonlyArray<{ name: string; url: string; kind?: string }>;
	readonly accounts?: ReadonlyArray<{ name: string; address: string }>;
	readonly coins?: ReadonlyArray<{ name: string; type: string; decimals: number }>;
	readonly extras?: Record<string, unknown>;
}

export const manifestCommand = Command.make(
	'manifest',
	{
		path: Argument.string('path').pipe(Argument.optional),
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Print raw manifest JSON instead of a human-readable summary'),
		),
	},
	({ path, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const filePath = Option.getOrElse(path, defaultManifestPath);
			const absolute = resolvePath(process.cwd(), filePath);

			const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
			if (!exists) {
				yield* Console.error(
					`manifest not found at ${absolute}\n` +
						`  run \`devstack apply\` or \`devstack up\` to write it`,
				);
				return yield* Effect.fail(new Error('manifest not found'));
			}

			const raw = yield* fs.readFileString(filePath).pipe(
				Effect.mapError((cause) => {
					const err = new Error(`failed to read ${absolute}: ${String(cause)}`);
					(err as Error & { cause?: unknown }).cause = cause;
					return err;
				}),
			);

			if (json) {
				yield* Console.log(raw.trimEnd());
				return;
			}

			let parsed: ManifestSummary;
			try {
				parsed = JSON.parse(raw) as ManifestSummary;
			} catch (cause) {
				yield* Console.error(`failed to parse manifest at ${absolute}: ${String(cause)}`);
				return yield* Effect.fail(new Error('manifest parse failure'));
			}

			yield* Console.log(`devstack manifest`);
			yield* Console.log(`  path: ${absolute}`);

			const pkgs = parsed.packages ?? [];
			const eps = parsed.endpoints ?? [];
			const accts = parsed.accounts ?? [];
			const coins = parsed.coins ?? [];
			const extras = parsed.extras ?? {};

			if (eps.length > 0) {
				yield* Console.log(`  endpoints:`);
				for (const ep of eps) {
					const kind = ep.kind ? ` [${ep.kind}]` : '';
					yield* Console.log(`    ${ep.name}${kind}: ${ep.url}`);
				}
			}
			if (pkgs.length > 0) {
				yield* Console.log(`  packages:`);
				for (const pkg of pkgs) {
					yield* Console.log(`    ${pkg.name}: ${pkg.packageId}`);
				}
			}
			if (accts.length > 0) {
				yield* Console.log(`  accounts:`);
				for (const acct of accts) {
					yield* Console.log(`    ${acct.name}: ${acct.address}`);
				}
			}
			if (coins.length > 0) {
				yield* Console.log(`  coins:`);
				for (const coin of coins) {
					yield* Console.log(`    ${coin.name}: ${coin.type} (${coin.decimals} decimals)`);
				}
			}
			const extraKeys = Object.keys(extras);
			if (extraKeys.length > 0) {
				yield* Console.log(`  extras: ${extraKeys.length} key${extraKeys.length === 1 ? '' : 's'}`);
				for (const key of extraKeys) {
					yield* Console.log(`    ${key}`);
				}
			}

			const empty =
				pkgs.length === 0 &&
				eps.length === 0 &&
				accts.length === 0 &&
				coins.length === 0 &&
				extraKeys.length === 0;
			if (empty) {
				yield* Console.log(`  (empty)`);
			}
		}),
).pipe(Command.withDescription('Print the current `.devstack/manifest.json`'));
