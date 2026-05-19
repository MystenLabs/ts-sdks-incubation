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
// `<stateDir>/stacks/<stack>/manifest.json`.

import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { promises as nodeFs } from 'node:fs';
import { readStackContext } from '../../runtime/read-stack-context.js';
import { failAlreadyReported } from '../already-reported.js';

export const manifestCommand = Command.make(
	'manifest',
	{
		path: Argument.string('path').pipe(Argument.optional),
		json: Flag.boolean('json').pipe(
			Flag.withDescription('Print raw manifest JSON instead of a human-readable summary'),
		),
	},
	({ path, json }) =>
		readStackContext({ manifestPath: Option.getOrUndefined(path) }).pipe(
			Effect.flatMap((ctx) =>
				Effect.gen(function* () {
					if (json) {
						// Emit the raw file body unchanged (preserves byte-for-byte
						// what's on disk — `--json` is a scripting surface).
						const raw = yield* Effect.tryPromise({
							try: () => nodeFs.readFile(ctx.manifestPath, 'utf8'),
							catch: (cause) =>
								new Error(`failed to read ${ctx.manifestPath}: ${String(cause)}`),
						});
						yield* Console.log(raw.trimEnd());
						return;
					}

					yield* Console.log(`devstack manifest`);
					yield* Console.log(`  path: ${ctx.manifestPath}`);

					const m = ctx.manifest;
					const eps = Object.entries(m.services).flatMap(([_svc, _block]) => [] as never[]);
					void eps; // structured rendering below
					const pkgs = Object.entries(m.packages);
					const accts = Object.entries(m.accounts);
					const coins = Object.entries(m.coins);
					const extras = m.app.extras;

					// Endpoints: walk the typed services + app block, projecting
					// to a flat name/url/kind table for the rendering below.
					const printedEps: Array<{ name: string; url: string; kind?: string }> = [];
					if (m.services.sui !== undefined) {
						printedEps.push({ name: 'sui-rpc', url: m.services.sui.rpc.url });
						if (m.services.sui.faucet !== undefined)
							printedEps.push({ name: 'sui-faucet', url: m.services.sui.faucet.url });
						if (m.services.sui.graphql !== undefined)
							printedEps.push({ name: 'sui-graphql', url: m.services.sui.graphql.url });
					}
					if (m.services.seal !== undefined)
						printedEps.push({ name: 'seal-key-server', url: m.services.seal.keyServer.url });
					if (m.services.walrus !== undefined) {
						printedEps.push({
							name: 'walrus-aggregator',
							url: m.services.walrus.aggregator.url,
						});
						printedEps.push({ name: 'walrus-publisher', url: m.services.walrus.publisher.url });
					}
					if (m.app.dev !== undefined)
						printedEps.push({ name: 'frontend.dev-server', url: m.app.dev.url });
					if (m.app.wallet !== undefined)
						printedEps.push({ name: 'wallet-app', url: m.app.wallet.url });

					if (printedEps.length > 0) {
						yield* Console.log(`  endpoints:`);
						for (const ep of printedEps) {
							yield* Console.log(`    ${ep.name}: ${ep.url}`);
						}
					}
					if (pkgs.length > 0) {
						yield* Console.log(`  packages:`);
						for (const [name, pkg] of pkgs) {
							yield* Console.log(`    ${name}: ${pkg.id}`);
						}
					}
					if (accts.length > 0) {
						yield* Console.log(`  accounts:`);
						for (const [name, acct] of accts) {
							yield* Console.log(`    ${name}: ${acct.address}`);
						}
					}
					if (coins.length > 0) {
						yield* Console.log(`  coins:`);
						for (const [name, coin] of coins) {
							yield* Console.log(`    ${name}: ${coin.type} (${coin.decimals} decimals)`);
						}
					}
					const extraKeys = Object.keys(extras);
					if (extraKeys.length > 0) {
						yield* Console.log(
							`  extras: ${extraKeys.length} key${extraKeys.length === 1 ? '' : 's'}`,
						);
						for (const key of extraKeys) {
							yield* Console.log(`    ${key}`);
						}
					}

					const empty =
						pkgs.length === 0 &&
						printedEps.length === 0 &&
						accts.length === 0 &&
						coins.length === 0 &&
						extraKeys.length === 0;
					if (empty) {
						yield* Console.log(`  (empty)`);
					}
				}),
			),
			Effect.catchTags({
				ManifestDiscoveryError: (cause) => failAlreadyReported(cause.message),
				ManifestShapeError: (cause) => failAlreadyReported(cause.message),
			}),
		),
).pipe(Command.withDescription('Print the current `.devstack/manifest.json`'));
