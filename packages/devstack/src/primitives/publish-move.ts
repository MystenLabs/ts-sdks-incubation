// publishMove — build + publish a local Move package against the
// resolved `Sui` chain, optionally registering published coins (the
// `coins:` shorthand) and capturing extra object ids from the publish
// transaction's object changes (the `capture:` callback). The per-name
// tag satisfies `LocalPackage` (refining `Package`) so consumers that
// need post-publish capabilities — `bindings`, the upgrade cap — can
// constrain to it. Source-tree content-hashing folds into the
// `StateStore` cache key, so a no-op rebuild reuses the previously
// published `packageId` and downstream caches stay warm.

import { Effect, FileSystem, Option, Schedule } from 'effect';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import { tag, setPhase, type Ref } from '../advanced/tag.js';
import { SuiTag } from '../services/sui.js';
import { buildMove, scrubCachedMoveLocks } from '../engine/sui-cli.js';
import { PackageRegistry, CoinRegistry } from '../engine/registries.js';
import { StateStore } from '../engine/state-store.js';
import { PublishError } from './errors.js';
import type { LocalPackageShape } from '../services/package.js';
import { toSdkCoin } from '../services/package.js';
import type { Account, SuiObjectChange } from './shared.js';
import { pickCreatedByTypeSuffix } from './sui-helpers.js';

// Content-hash the Move source tree under `sourcePath`. Hashes every
// `.move` file plus `Move.toml`, ignoring build/output/hidden dirs so
// stale `build/` artifacts never participate. Entries are sorted at
// each level for deterministic ordering across runners. Folded into
// the StateStore cache key so any edit to a tracked source file misses
// the cache and triggers a re-publish, while a no-op rebuild reuses
// the previously published packageId (which downstream caches key
// off).
const hashMoveSources = (sourcePath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = crypto.createHash('sha256');
		const walk = (
			dir: string,
		): Effect.Effect<void, PublishError, FileSystem.FileSystem> =>
			Effect.gen(function* () {
				const entries = (yield* fs.readDirectory(dir)).slice().sort();
				for (const name of entries) {
					if (name.startsWith('.') || name === 'build' || name === 'node_modules') continue;
					const full = path.join(dir, name);
					const stat = yield* fs.stat(full);
					if (stat.type === 'Directory') {
						yield* walk(full);
					} else if (stat.type === 'File' && (name.endsWith('.move') || name === 'Move.toml')) {
						const rel = path.relative(sourcePath, full);
						const content = yield* fs.readFile(full);
						hash.update(rel + '\0');
						hash.update(content);
						hash.update('\0');
					}
				}
			}).pipe(
				Effect.catchTag('PlatformError', (cause) =>
					Effect.fail(
						new PublishError({
							stage: 'hash',
							message: `hashMoveSources '${sourcePath}': ${cause.message}`,
							cause,
						}),
					),
				),
			);
		yield* walk(sourcePath);
		const digest = hash.digest('hex').slice(0, 16);
		yield* Effect.annotateCurrentSpan({
			'publishMove.sourcePath': sourcePath,
			'publishMove.sourceHash': digest,
		});
		return digest;
	}).pipe(Effect.withSpan('publishMove.hash-sources'));

export interface CoinSpec {
	readonly name: string;
	readonly module: string;
	readonly type: string;
	readonly decimals: number;
}

export interface PublishedCoin extends CoinSpec {
	readonly fullCoinType: string;
	/**
	 * SDK-aligned projection — see `CoinShape['sdkCoin']`. Same value
	 * `registerCoin` emits, so downstream consumers can read either tag
	 * shape uniformly.
	 */
	readonly sdkCoin: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
}

// Per-call shape returned by `publishMove`. Carries the universal
// `LocalPackageShape` fields (so the per-name tag satisfies the
// `LocalPackageTag` contract in `services/package.ts` structurally) plus
// `coins` — a typed record of the published coin specs the caller
// declared. `bindings` keys off `LocalPackageShape` so a known-package
// tag (which only satisfies `PackageShape`) is rejected at compose time.
export interface Package<
	TCaptured = undefined,
	TCoins extends Record<string, PublishedCoin> = Record<string, PublishedCoin>,
> {
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId: string | undefined;
	readonly captured: TCaptured;
	readonly coins: TCoins;
	readonly sourcePath: string;
	readonly mvrPlaceholder: string;
}

// Compile-time guard: if a future edit ever drops a `LocalPackageShape`
// field from `Package`, this check breaks and `bindings`' input type
// stops accepting `publishMove` tags. The check uses the most-permissive
// instantiation (`captured: Record<string, unknown> | undefined`) because
// concrete `TCaptured` choices the caller's `capture` lambda produces
// flow through structurally at the call site.
type _LocalPackageCompatibilityCheck = Package<
	Record<string, unknown> | undefined,
	Record<string, PublishedCoin>
> extends LocalPackageShape
	? true
	: never;
const _localPackageCompatibilityCheck: _LocalPackageCompatibilityCheck = true;
void _localPackageCompatibilityCheck;

type CoinsRecord<T extends ReadonlyArray<CoinSpec>> = {
	readonly [K in T[number]['name']]: PublishedCoin;
};

export interface PublishMoveOptions<
	Name extends string,
	TCaptured,
	TCoins extends ReadonlyArray<CoinSpec>,
> {
	/**
	 * Tag name. Used for the per-call tag (downstream consumers
	 * `yield*` it), the manifest entry, and the Move address
	 * placeholder (`<name>::module::Type` references in
	 * `Move.toml` bind to `0x0` at build time and rewrite to the
	 * published `packageId` post-publish).
	 */
	readonly name: Name;
	/**
	 * Filesystem path to the Move package root (the directory
	 * containing `Move.toml`). Resolved relative to `process.cwd()`;
	 * pass an absolute path when you can to avoid surprises under
	 * `pnpm dev` invocations from a non-package directory.
	 */
	readonly path: string;
	/**
	 * Account that signs the publish transaction and ends up holding
	 * the resulting `UpgradeCap`. The tag is yielded for ordering, so
	 * `signer` is always funded by the time the publish fires.
	 */
	readonly signer: Ref<any, Account, any, any>;
	/**
	 * Optional override for the Move-Resolved-Reference placeholder
	 * (the `[addresses]` table key in `Move.toml`). Defaults to `name`.
	 * Set when the package's `Move.toml` declares its own address under
	 * a key that differs from the tag name (e.g. legacy code shipped
	 * before MVR conventions).
	 */
	readonly mvrPlaceholder?: string;
	/**
	 * Optional projection over the publish transaction's
	 * `objectChanges`. The returned record is exposed on the resolved
	 * tag as `captured` and serialized into the manifest's
	 * `packages[].captured`. Use for object ids the package creates
	 * during publish (treasury caps, admin caps, registry singletons)
	 * that downstream consumers need to address. Pair with the
	 * `pickCreatedByType*` helpers from `./sui-helpers.ts`.
	 */
	readonly capture?: (changes: ReadonlyArray<SuiObjectChange>) => TCaptured;
	/**
	 * Optional coin specs to register against the published package.
	 * Each entry surfaces in the `CoinRegistry` (manifest + `Coin` tag
	 * for downstream consumers) without the caller having to add a
	 * separate `registerCoin` primitive. The `module` + `type` fields
	 * key into the published package's coin types.
	 */
	readonly coins?: TCoins;
}

const UPGRADE_CAP_TYPE_SUFFIX = '0x2::package::UpgradeCap';

export const publishMove = <
	const Name extends string,
	TCaptured = undefined,
	const TCoins extends ReadonlyArray<CoinSpec> = [],
>(
	options: PublishMoveOptions<Name, TCaptured, TCoins>,
) =>
	tag(
		options.name,
		Effect.gen(function* () {
			const signer = yield* options.signer;
			const sui = yield* SuiTag;
			const state = yield* StateStore;

			// Content-hash the Move source tree and probe the StateStore
			// cache before doing any work. The key folds in the chain
			// identifier so a regenesis of the underlying chain naturally
			// misses the cache (the previously published packageId no
			// longer exists). On a hit we skip scrub + build + publish
			// entirely and reuse the prior `Package` — keeps downstream
			// caches (e.g. layers keyed on `packageId`) stable across
			// no-op rebuilds. v3 does the same with its input-hash fold
			// in `packages/devstack/src/helpers/publish-move.ts`.
			// MVR (Move Registry) names accept only `[a-z0-9-]+` after the
			// scope prefix — underscores fail dapp-kit's `validateOverrides`
			// at runtime. Sanitize the package name into a valid MVR slug so
			// `connect_four` becomes `connect-four`. Callers can still pin
			// an exact `mvrPlaceholder` via options.
			const mvrSlug = options.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
			const mvrPlaceholder = options.mvrPlaceholder ?? `@local/${mvrSlug}`;
			const sourceHash = yield* hashMoveSources(options.path);
			const cacheKey = `publishMove/${options.name}/${sourceHash}/${sui.chainId}`;
			const cached = yield* state.get<Package<TCaptured, CoinsRecord<TCoins>>>(cacheKey);
			if (Option.isSome(cached)) {
				yield* Effect.logInfo(
					`publishMove(${options.name}): cache hit — chainId=${sui.chainId} sourceHash=${sourceHash} packageId=${cached.value.packageId}`,
				);
				yield* Effect.annotateCurrentSpan({
					'publishMove.cache': 'hit',
					'publishMove.packageId': cached.value.packageId,
					'publishMove.sourceHash': sourceHash,
				});
				// Re-attach host-local fields (sourcePath, mvrPlaceholder) to
				// the cached payload — they're host-specific so we don't
				// persist them, but downstream primitives (bindings) need
				// them on the yielded shape.
				//
				// Cache entries written before `sdkCoin` landed lack the field;
				// backfill defensively so existing on-disk caches survive a
				// version bump without a forced wipe.
				const cachedCoins = cached.value.coins as Record<string, PublishedCoin>;
				const rehydratedCoins = {} as Record<string, PublishedCoin>;
				for (const [k, c] of Object.entries(cachedCoins)) {
					rehydratedCoins[k] = {
						...c,
						sdkCoin: c.sdkCoin ?? toSdkCoin({ fullCoinType: c.fullCoinType, decimals: c.decimals }),
					};
				}
				const hit: Package<TCaptured, CoinsRecord<TCoins>> = {
					...cached.value,
					coins: rehydratedCoins as CoinsRecord<TCoins>,
					sourcePath: options.path,
					mvrPlaceholder,
				};
				// Re-register on every run — registries live in-memory per
				// engine invocation and a cache hit must still surface the
				// package + coins to downstream consumers (mvr resolver,
				// status command, etc.).
				yield* PackageRegistry.publish({
					name: options.name,
					packageId: hit.packageId,
					upgradeCapId: hit.upgradeCapId,
					mvrPlaceholder,
					captured: hit.captured as Record<string, unknown> | undefined,
				});
				for (const coin of Object.values(hit.coins) as ReadonlyArray<PublishedCoin>) {
					yield* CoinRegistry.publish({
						name: coin.name,
						type: coin.fullCoinType,
						decimals: coin.decimals,
						sdkCoin: coin.sdkCoin,
					});
				}
				return hit;
			}
			yield* Effect.annotateCurrentSpan({
				'publishMove.cache': 'miss',
				'publishMove.sourceHash': sourceHash,
			});

			// Strip `[env.testnet]` / `[env.mainnet]` sections from cached
			// `~/.move/git/**/Move.lock` files before building. Without
			// this the sui-cli resolver short-circuits vendored deps
			// (e.g. deepbook's `token`) to their testnet/mainnet ids,
			// which don't exist on a fresh localnet. See
			// `scrubCachedMoveLocks` for details.
			yield* scrubCachedMoveLocks(options.path).pipe(
				Effect.catchTag('SuiCliError', (cause) =>
					Effect.fail(
						new PublishError({
							stage: 'scrub',
							message: `publishMove(${options.name}): scrub failed`,
							cause,
						}),
					),
				),
			);

			yield* setPhase('building move');
			// `buildMove` shells out to the host `sui` CLI (or one
			// embedded in the localnet image, dispatched via docker
			// exec). Either way the CLI itself dials the chain — use
			// the host URL form; the container alias is only valid
			// from inside containers attached to the per-stack sui
			// network.
			const { modules, dependencies } = yield* buildMove({
				path: options.path,
				rpcUrl: sui.rpc.host,
				faucetUrl: sui.faucet?.host,
			}).pipe(
				Effect.catchTag('SuiCliError', (cause) =>
					Effect.fail(
						new PublishError({
							stage: 'build',
							message: `publishMove(${options.name}): build failed`,
							cause,
						}),
					),
				),
			);

			yield* setPhase('publishing');
			const t = new Transaction();
			const [upgradeCap] = t.publish({ modules: [...modules], dependencies: [...dependencies] });
			t.transferObjects([upgradeCap], signer.address);

			const result = yield* signer.signAndExecute(t).pipe(
				Effect.catchTag('SignAndExecuteError', (cause) =>
					Effect.fail(
						new PublishError({
							stage: 'publish-tx',
							message: `publishMove(${options.name}): publish tx failed`,
							cause,
						}),
					),
				),
			);

			yield* setPhase('capturing');
			const published = result.objectChanges.find(
				(c): c is Extract<SuiObjectChange, { type: 'published' }> => c.type === 'published',
			);
			if (published === undefined) {
				return yield* Effect.fail(
					new PublishError({
						stage: 'parse',
						message: `publishMove(${options.name}): no 'published' change in result`,
					}),
				);
			}
			const packageId = published.packageId;

			// Wait for the fullnode to ingest the publish checkpoint before
			// returning. Without this, downstream `tx` primitives that
			// `signAndExecute` against the freshly-published package can
			// fail with `Dependent package not found on-chain` — the publish
			// tx digest is committed but the indexer hasn't propagated yet.
			// Poll `getObject(packageId)` until it returns; back off
			// exponentially up to 10s total.
			yield* Effect.gen(function* () {
				const response = yield* Effect.tryPromise({
					try: () => sui.client.getObject({ id: packageId, options: {} }),
					catch: (cause) => new Error(String(cause)),
				});
				// getObject returns {error: 'notExists'} (not a throw) when the
				// fullnode hasn't ingested the publish checkpoint yet. Treat
				// that as a retryable not-yet-ready signal.
				if (response.error !== undefined && response.data === undefined) {
					return yield* Effect.fail(new Error(`package not yet on-chain: ${JSON.stringify(response.error)}`));
				}
			}).pipe(
				Effect.retry(Schedule.spaced('200 millis')),
				Effect.timeoutOrElse({
					duration: '10 seconds',
					orElse: () =>
						Effect.fail(
							new PublishError({
								stage: 'parse',
								message: `publishMove(${options.name}): publish tx succeeded but package ${packageId} did not become queryable within 10s`,
							}),
						),
				}),
			);

			const upgradeCapId = pickCreatedByTypeSuffix(result.objectChanges, UPGRADE_CAP_TYPE_SUFFIX);

			const captured = options.capture ? options.capture(result.objectChanges) : undefined;

			const coinSpecs = options.coins ?? ([] as ReadonlyArray<CoinSpec>);
			const coins = {} as Record<string, PublishedCoin>;
			for (const spec of coinSpecs) {
				const fullCoinType = `${packageId}::${spec.module}::${spec.type}`;
				coins[spec.name] = {
					...spec,
					fullCoinType,
					sdkCoin: toSdkCoin({ fullCoinType, decimals: spec.decimals }),
				};
			}

			yield* PackageRegistry.publish({
				name: options.name,
				packageId,
				upgradeCapId,
				mvrPlaceholder,
				captured: captured as Record<string, unknown> | undefined,
			});

			for (const coin of Object.values(coins)) {
				yield* CoinRegistry.publish({
					name: coin.name,
					type: coin.fullCoinType,
					decimals: coin.decimals,
					sdkCoin: coin.sdkCoin,
				});
			}

			const result_: Package<TCaptured, CoinsRecord<TCoins>> = {
				name: options.name,
				packageId,
				upgradeCapId,
				captured: captured as TCaptured,
				coins: coins as unknown as CoinsRecord<TCoins>,
				sourcePath: options.path,
				mvrPlaceholder,
			};

			// Cache against the source-hash + chainId key so the next
			// build of the same tree against the same chain reuses this
			// packageId. Downstream layers key off `packageId`, so a
			// stable hit here cascades into stable layer hashes. `sourcePath`
			// + `mvrPlaceholder` are re-attached on cache hits (above),
			// not persisted — they're host-local and can change.
			yield* state.put(cacheKey, result_);

			return result_;
		}).pipe(Effect.withSpan(`publishMove(${options.name})`)),
		{
			kind: 'action',
			displayTitle: `publish.${options.name}`,
			// Auto-watch the Move source tree. An edit to a `.move` file
			// (or `Move.toml`) under `options.path` triggers a hot-restart;
			// the existing `hashMoveSources` cache fold ensures only a real
			// content change makes the next publish actually republish.
			// `bindings` consumers re-acquire as part of the same restart
			// so generated TS picks up the new ABI without manual steps.
			// Today this is whole-stack restart — selective per-primitive
			// tear-down is tracked under the G2a hot-restart follow-up.
			watch: [options.path],
			// Full packageId in `primary` so users can copy-paste it; the
			// dashboard wraps overflow rather than truncate with `…`. The
			// upgrade-cap is dropped from extras (full id would crowd the
			// row); users can find it in `manifest.json`.
			display: (s) => {
				const extras: Array<string> = [];
				const coinCount = Object.keys(s.coins).length;
				if (coinCount > 0) extras.push(`${coinCount} coin${coinCount === 1 ? '' : 's'}`);
				return {
					title: `publish.${s.name}`,
					primary: s.packageId,
					...(extras.length > 0 ? { extras } : {}),
				};
			},
		},
	);

// Capture helpers — moved to `sui-helpers.ts` so they can be imported by
// configs that don't otherwise touch publish-move. Re-exported here for
// back-compat with the previous import path used internally.
export { pickCreatedByTypeIncludes, pickCreatedByTypeSuffix } from './sui-helpers.js';
