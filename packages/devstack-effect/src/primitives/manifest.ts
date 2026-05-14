import { Effect, Schedule } from 'effect';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { makeTag } from '../tag.js';
import { Identity } from '../internal/identity.js';
import {
	AccountRegistry,
	CoinRegistry,
	EndpointRegistry,
	PackageRegistry,
} from '../internal/registries.js';
import { jsonBigintReplacer } from '../internal/json-bigint.js';
import { toSdkCoin } from '../interfaces/coin.js';
import { ManifestError } from './errors.js';

export interface ManifestData {
	readonly packages: ReadonlyArray<{
		readonly name: string;
		readonly packageId: string;
		readonly upgradeCapId?: string;
		readonly mvrPlaceholder?: string;
		readonly captured?: Record<string, unknown>;
		// Note: v3 strips `path` before write — don't include it in the emitted shape
	}>;
	readonly endpoints: ReadonlyArray<{
		readonly name: string;
		readonly url: string;
		readonly kind?: string;
		readonly pairUrl?: string;
	}>;
	readonly accounts: ReadonlyArray<{ readonly name: string; readonly address: string }>;
	readonly coins: ReadonlyArray<{
		readonly name: string;
		readonly type: string;
		readonly decimals: number;
		/**
		 * SDK-aligned projection. Always populated on emission — `manifest`
		 * derives it from `(type, decimals)` if the registry entry didn't
		 * carry one. Dapp-kit / SDK-consuming readers can splice this value
		 * directly into a `Coin` argument.
		 */
		readonly sdkCoin: {
			readonly address: string;
			readonly type: string;
			readonly scalar: number;
		};
	}>;
	readonly extras: Record<string, unknown>;
}

// Dedupe by name (last-wins) + alphabetical sort. Matches v3's
// `manifestData` so downstream readers see a stable, predictable
// shape regardless of registration order or duplicate registrations
// across HMR re-runs.
const dedupeAndSort = <T extends { readonly name: string }>(items: ReadonlyArray<T>): Array<T> => {
	const map = new Map<string, T>();
	for (const item of items) map.set(item.name, item);
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const sortObjectKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj).sort()) out[key] = obj[key];
	return out;
};

export interface ManifestOptions<Name extends string, E, R> {
	readonly name?: Name;
	readonly output?: string;
	/**
	 * Static extras included in the manifest sidecar. Three forms:
	 *   - **Plain object** (e.g. `{ appName: 'arena' }`): serialized verbatim.
	 *   - **Sync function** (`() => ({...})`): called once at acquire.
	 *   - **Effect** (`Effect.gen(function* () { ... })`): for tag-dependent data.
	 *
	 * **SECURITY**: plain objects + sync functions are serialized verbatim
	 * to `.devstack/manifest.json`. **Never pass secrets** (env values, tokens,
	 * keys) through this surface — manifest is read by dapp-kit at dev time
	 * and any value here is recoverable from disk. Use `Effect.gen` if you
	 * need to redact / transform the data before serialization.
	 */
	readonly extras?:
		| Record<string, unknown>
		| (() => Record<string, unknown>)
		| Effect.Effect<Record<string, unknown>, E, R>;
}

export const manifest = <const Name extends string = 'manifest', E = never, R = never>(
	options: ManifestOptions<Name, E, R> = {},
) => {
	const name = (options.name ?? 'manifest') as Name;
	const explicitOutput = options.output;
	return makeTag(
		name,
		Effect.gen(function* () {
			const pkgs = yield* PackageRegistry;
			const eps = yield* EndpointRegistry;
			const accts = yield* AccountRegistry;
			const coins = yield* CoinRegistry;
			// Stack-scoped path: `.devstack/stacks/<stack>/manifest.json`
			// when running on a non-main stack, with the legacy
			// `.devstack/manifest.json` byte-identical for the default
			// `<main>` stack so warm-restart / playwright readers keep
			// working unchanged. The caller's explicit `output` always
			// wins. Closes #28 (manifest path not stack-scoped).
			const identity = yield* Identity;
			const outputPath =
				explicitOutput ??
				(identity.stack === 'main'
					? '.devstack/manifest.json'
					: `.devstack/stacks/${identity.stack}/manifest.json`);

			// Resolve `extras` at build time so any failure surfaces before
			// the rest of the stack acquires. The runtime discriminator
			// (Effect → function → plain object) keeps the surface friendly
			// for callers that just want to drop a static record in.
			let extras: Record<string, unknown> = {};
			const rawExtras = options.extras;
			if (rawExtras !== undefined) {
				if (Effect.isEffect(rawExtras)) {
					extras = yield* rawExtras;
				} else if (typeof rawExtras === 'function') {
					extras = rawExtras();
				} else {
					extras = rawExtras;
				}
			}

			const snapshotAndWrite = Effect.gen(function* () {
				const rawPkgs = yield* pkgs.snapshot;
				const rawEps = yield* eps.snapshot;
				const rawAccts = yield* accts.snapshot;
				const rawCoins = yield* coins.snapshot;

				// Dedupe-by-name + alphabetical sort matches v3's on-disk
				// shape. Last registration wins so HMR-style re-runs that
				// re-register the same name don't accumulate dupes.
				const data: ManifestData = {
					packages: dedupeAndSort(rawPkgs).map((p) => ({
						name: p.name,
						packageId: p.packageId,
						...(p.upgradeCapId !== undefined ? { upgradeCapId: p.upgradeCapId } : {}),
						...(p.mvrPlaceholder !== undefined ? { mvrPlaceholder: p.mvrPlaceholder } : {}),
						...(p.captured !== undefined ? { captured: p.captured } : {}),
					})),
					endpoints: dedupeAndSort(rawEps).map((e) => ({
						name: e.name,
						url: e.url,
						...(e.kind !== undefined ? { kind: e.kind } : {}),
						...(e.pairUrl !== undefined ? { pairUrl: e.pairUrl } : {}),
					})),
					accounts: dedupeAndSort(rawAccts),
					coins: dedupeAndSort(rawCoins).map((c) => ({
						name: c.name,
						type: c.type,
						decimals: c.decimals,
						sdkCoin: c.sdkCoin ?? toSdkCoin({ fullCoinType: c.type, decimals: c.decimals }),
					})),
					extras: sortObjectKeys(extras),
				};
				const body = JSON.stringify(data, jsonBigintReplacer, 2);

				// We write to two paths on non-main stacks:
				//   - The canonical stack-scoped path (outputPath, e.g.
				//     `.devstack/stacks/test/manifest.json`).
				//   - The legacy flat path `.devstack/manifest.json`
				//     too. Reason: examples' `src/generated/manifest.ts`
				//     hardcodes `import '../../.devstack/manifest.json'`
				//     because vite resolves imports at build time
				//     (can't dynamically pick by stack). Without the
				//     legacy write, vite fails with `failed to resolve
				//     import "../../.devstack/manifest.json"` and the
				//     dev-server can't load. Limitation: two concurrent
				//     stacks racing on the same example would overwrite
				//     each other's flat manifest; the stack-scoped path
				//     stays authoritative for that case (and a future
				//     dynamic-import strategy in the example would let
				//     each stack pick its own).
				// Resolve the legacy `.devstack/manifest.json` path for
				// non-main stacks. outputPath is `<root>/.devstack/stacks/<stack>/manifest.json`;
				// strip the trailing two segments and the stack dir to
				// reach `<root>/.devstack/manifest.json`.
				const isMainStack = outputPath.endsWith(path.join('.devstack', 'manifest.json'));
				const legacyPath = isMainStack
					? undefined
					: path.join(
							path.dirname(path.dirname(path.dirname(outputPath))),
							'manifest.json',
						);

				const wrote = yield* Effect.tryPromise({
					try: async (): Promise<boolean> => {
						// Idempotent-write: read what's already on disk; skip
						// the write entirely if the body matches. Keeps Vite
						// HMR quiet on no-op re-runs and leaves mtime stable
						// for downstream staleness checks.
						let existing: string | undefined;
						try {
							existing = await fs.readFile(outputPath, 'utf-8');
						} catch {
							// file missing — fall through to write
						}
						let didWrite = false;
						if (existing !== body) {
							await fs.mkdir(path.dirname(outputPath), { recursive: true });
							await fs.writeFile(outputPath, body, 'utf-8');
							didWrite = true;
						}
						if (legacyPath !== undefined) {
							let legacyExisting: string | undefined;
							try {
								legacyExisting = await fs.readFile(legacyPath, 'utf-8');
							} catch {
								// missing — fall through
							}
							if (legacyExisting !== body) {
								await fs.mkdir(path.dirname(legacyPath), { recursive: true });
								await fs.writeFile(legacyPath, body, 'utf-8');
								didWrite = true;
							}
						}
						return didWrite;
					},
					catch: (cause) =>
						new ManifestError({
							phase: 'write',
							message: `failed to write manifest to ${outputPath}`,
							cause,
						}),
				}).pipe(
					Effect.catch((err: ManifestError) =>
						Effect.logWarning(`manifest(${name}): ${err.message}`).pipe(
							Effect.annotateLogs({ cause: err.cause }),
							Effect.as(false),
						),
					),
				);

				// chmod only on actual write — chmod changes mtime on some
				// filesystems, which would trigger Vite's HMR watcher on every
				// 500ms tick of the manifest's watch loop and put the dev
				// server in a permanent-reload state.
				if (wrote) {
					yield* Effect.tryPromise(() => fs.chmod(outputPath, 0o600)).pipe(
						Effect.ignore({ log: true }),
					);
				}
			});

			// Eager write: dapp-kit reads the manifest at dev-server start, so
			// the file must exist before the stack's scope finalizes. Upstream
			// registry data has already been gathered via the `yield*`s above.
			yield* snapshotAndWrite.pipe(Effect.withSpan('manifest.write'));

			// Re-snapshot on a slow tick during the stack's lifetime. Manifest
			// acquires in parallel with the other primitives, so an eager
			// write at acquire-time captures only what's already published —
			// late registrations (e.g. `walletApp` registering its endpoint
			// after `manifest` has already returned) wouldn't otherwise land
			// on disk until scope teardown, by which point a live frontend
			// has already read the file. The write is content-idempotent
			// (compares the rendered body against what's on disk and skips
			// if equal), so the steady-state cost is one stat + read per
			// tick. Runs as a forked background fiber scoped to the
			// manifest's scope, so it tears down cleanly on stack stop.
			yield* Effect.forkScoped(
				snapshotAndWrite.pipe(
					Effect.ignore({ log: true }),
					Effect.repeat(Schedule.spaced('500 millis')),
					Effect.withSpan('manifest.watch'),
				),
			);

			// Final flush captures any downstream mutations during the stack's
			// lifetime (e.g. captured logs) before scope teardown.
			yield* Effect.addFinalizer(() =>
				snapshotAndWrite.pipe(Effect.withSpan('manifest.finalize')),
			);

			// Build-time view: registries are still empty (everything else is
			// composed in parallel). Consumers should read the manifest from
			// `output` after the stack is up, not yield* this tag.
			return {
				packages: [],
				endpoints: [],
				accounts: [],
				coins: [],
				extras,
			} satisfies ManifestData;
		}).pipe(Effect.withSpan(`manifest(${name})`)),
		{
			kind: 'action',
			displayTitle: 'manifest',
			// The on-disk path is resolved inside the build body (it
			// depends on `Identity.stack`). For the TUI's pre-build
			// display we fall back to the explicit `output` if the
			// caller set one, otherwise the legacy default — close
			// enough; the row gets re-rendered once the body settles.
			display: () => ({ title: 'manifest', primary: explicitOutput ?? '.devstack/manifest.json' }),
		},
	);
};
