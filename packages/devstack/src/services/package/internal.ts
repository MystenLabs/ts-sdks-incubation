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
import { tag, setPhase, type LayeredTag } from '../../advanced/tag.js';
import { SuiTag } from '../sui.js';
import { buildMove, scrubCachedMoveLocks } from '../../engine/sui-cli.js';
import { publishCoin, publishPackage } from '../../engine/registries.js';
import { StateStore } from '../../engine/state-store.js';
import { PublishError } from '../../engine/errors.js';
import type { LocalPackage } from '../package.js';
import { toSdkCoin } from '../package.js';
import type { Account, SuiObjectChange } from '../../engine/shared.js';
import { pickCreatedByType } from '../../engine/sui-helpers.js';
import { FaucetTag } from '../faucet/index.js';
import { treasuryCapMintStrategy } from '../faucet/strategies/treasury-cap-mint.js';
import { discoverCoinsFromPublish } from '../coin/discovery.js';
import { fetchCoinMetadataMany, type OnchainCoinMetadata } from '../coin/loader.js';

// Content-hash the Move source tree under `sourcePath`. Hashes every
// `.move` file plus `Move.toml`, ignoring build/output/hidden dirs so
// stale `build/` artifacts never participate. Entries are sorted at
// each level for deterministic ordering across runners. Folded into
// the StateStore cache key so any edit to a tracked source file misses
// the cache and triggers a re-publish, while a no-op rebuild reuses
// the previously published packageId (which downstream caches key
// off).
//
// Exported for test-only use — production callers go through
// `publishMove`. The function is the load-bearing cache-key derivation
// for snapshot-restore correctness, so `internal.test.ts` pins its
// invariants directly.
export const hashMoveSources = (sourcePath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hash = crypto.createHash('sha256');
		const walk = (dir: string): Effect.Effect<void, PublishError, FileSystem.FileSystem> =>
			Effect.gen(function* () {
				const entries = (yield* fs.readDirectory(dir)).slice().sort();
				for (const name of entries) {
					if (name.startsWith('.') || name === 'build' || name === 'node_modules') continue;
					const full = path.join(dir, name);
					const stat = yield* fs.stat(full);
					if (stat.type === 'Directory') {
						yield* walk(full);
					} else if (
						stat.type === 'File' &&
						(name.endsWith('.move') ||
							name === 'Move.toml' ||
							// HIGH-C1: include Move.lock in the digest. The
							// lockfile carries resolved dependency package ids
							// (git pins, on-chain addresses) — a dependency
							// upgrade or relocation is invisible to a hash
							// that only walks `.move` + `Move.toml`, leaving
							// the package's bytecode addressing the wrong
							// upstream. Hashing the lockfile makes the cache
							// key honest about every input that affects the
							// resulting package id.
							name === 'Move.lock')
					) {
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
							phase: 'hash',
							message: `hashMoveSources '${sourcePath}': ${cause.message}`,
							cause,
						}),
					),
				),
			);
		yield* walk(sourcePath);
		// Stays at 16 hex chars to preserve compatibility with the
		// state-store entries written by older devstack versions; HIGH-C1
		// only widens the INPUT set (now includes Move.lock) without
		// changing the hash width.
		const digest = hash.digest('hex').slice(0, 16);
		yield* Effect.annotateCurrentSpan({
			'publishMove.sourcePath': sourcePath,
			'publishMove.sourceHash': digest,
		});
		return digest;
	}).pipe(Effect.withSpan('publishMove.hash-sources'));

// `PublishedCoin` is the runtime shape every entry of `pkg.coins[<key>]`
// satisfies. `name` is the registry key (the discovered symbol, or
// witness fallback when there's no CoinMetadata). `module` / `type` /
// `decimals` are derived from the publish receipt + the on-chain
// CoinMetadata respectively. Internal-only; downstream consumers reach
// for the shape through `Coin.fromPackage(pkg, witness)` or the
// `CoinValue` returned by `Coin('SYMBOL')`.
export interface PublishedCoin {
	readonly name: string;
	readonly module: string;
	readonly type: string;
	readonly decimals: number;
	readonly fullCoinType: string;
	/**
	 * SDK-aligned projection — see `Coin['sdkCoin']`. Same shape every
	 * `Coin(...)` factory ref carries, so downstream consumers can read
	 * either the per-coin tag or the package's `coins.<key>` field
	 * uniformly.
	 */
	readonly sdkCoin: {
		readonly address: string;
		readonly type: string;
		readonly scalar: number;
	};
	/**
	 * TreasuryCap object id captured from the publish's `objectChanges`.
	 * Surfaces here so downstream consumers (custom mint flows, the
	 * auto-registered TreasuryCap mint faucet strategy) can address the
	 * cap without re-querying chain state. `undefined` when no cap was
	 * created (rare — typically means the coin's `init` doesn't follow
	 * the standard `coin::create_currency` pattern).
	 */
	readonly treasuryCapId?: string;
	// Populated when `discoverCoinsFromPublish` matches a
	// `CoinMetadata<<fullCoinType>>` to this coin AND
	// `CoinMetadataLoader.getMany` returns a payload. A flaky RPC at
	// publish time degrades to "fields undefined" (warning logged); the
	// next supervisor cycle picks them up.
	readonly metadataId?: string;
	readonly treasuryCapOwner?: string;
	readonly publisherOwnsCap?: boolean;
	readonly symbol?: string;
	readonly displayName?: string;
	readonly iconUrl?: string;
	readonly packageId?: string;
}

// Per-call shape returned by `publishMove`. Carries the universal
// `LocalPackage` fields (so the per-name tag satisfies the
// `LocalPackageTag` contract in `services/package.ts` structurally) plus
// `coins` — the auto-discovered record of every coin the publish
// created. `bindings` keys off `LocalPackage` so a known-package tag
// (which only satisfies `Package`) is rejected at compose time.
export interface Package<TCaptured = undefined> {
	readonly name: string;
	readonly packageId: string;
	readonly upgradeCapId: string | undefined;
	readonly captured: TCaptured;
	readonly coins: Record<string, PublishedCoin>;
	readonly sourcePath: string;
	readonly mvrPlaceholder: string;
}

// Compile-time guard: if a future edit ever drops a `LocalPackage`
// field from `Package`, this check breaks and `bindings`' input type
// stops accepting `publishMove` tags. The check uses the most-permissive
// instantiation (`captured: Record<string, unknown> | undefined`) because
// concrete `TCaptured` choices the caller's `capture` lambda produces
// flow through structurally at the call site.
type _LocalPackageCompatibilityCheck =
	Package<Record<string, unknown> | undefined> extends LocalPackage ? true : never;
const _localPackageCompatibilityCheck: _LocalPackageCompatibilityCheck = true;
void _localPackageCompatibilityCheck;

// `PublishMoveOptions` carries the kitchen-sink shape `publishMove`
// accepts. The user-facing `Package(name, path, opts)` and
// `PackageWithCapture(name, path, opts)` factories each project into a
// subset of these fields; this interface stays internal.
export interface PublishMoveOptions<Name extends string, TCaptured> {
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
	readonly signer: LayeredTag<any, Account, any, any>;
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
	 * `packages[].captured`. The user-facing `Package(...)` factory
	 * does NOT expose this; the `/advanced` `PackageWithCapture(...)`
	 * factory does. Used for unusual cases (DAO patterns, custom init
	 * that creates non-standard shared objects) where coin
	 * auto-discovery alone isn't enough. Pair with the
	 * `pickCreatedByType` helper from `./sui-helpers.ts`.
	 */
	readonly capture?: (changes: ReadonlyArray<SuiObjectChange>) => TCaptured;
}

const UPGRADE_CAP_TYPE_SUFFIX = '0x2::package::UpgradeCap';

// Register a `treasuryCapMintStrategy` per coin so
// `Account({ funding: { '<pkgId>::module::TYPE': amount } })` mints
// directly off the publisher's TreasuryCap. Re-runs on every supervisor
// cycle (Faucet's strategy registry is in-memory per cycle), and runs
// on both cache-miss and cache-hit publish paths.
//
// Best-effort: if no `Faucet` is in scope (rare — only unit tests that
// build the publish layer without `devstack(...)`) the registration is
// a noop. Coins missing a `treasuryCapId` (e.g. a custom init that
// doesn't follow `coin::create_currency`) are skipped — funding such a
// coin via `Account({ funding })` will surface a clean "no strategy
// registered" error pointing the user at the `FaucetStrategy` literal
// shape on `/advanced`.
const registerMintStrategies = (
	signer: Account,
	coins: ReadonlyArray<PublishedCoin>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const faucetOpt = yield* Effect.serviceOption(FaucetTag);
		if (faucetOpt._tag !== 'Some') return;
		const faucet = faucetOpt.value;
		for (const coin of coins) {
			if (coin.treasuryCapId === undefined) continue;
			// Skip mint registration for coins whose TreasuryCap isn't
			// held by the publisher (DAO patterns, shared caps). The coin
			// is still recorded in `coins` so reads (balance display,
			// Coin('SYMBOL') resolution) work — only mint via faucet is
			// gated.
			if (coin.publisherOwnsCap === false) continue;
			yield* faucet.register(
				treasuryCapMintStrategy({
					coinType: coin.fullCoinType,
					treasuryCapId: coin.treasuryCapId,
					signer,
				}),
			);
		}
	});

export const publishMove = <const Name extends string, TCaptured = undefined>(
	options: PublishMoveOptions<Name, TCaptured>,
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
			//
			// Phase D refinements:
			//   - Collapse runs of `-` so `foo__bar` doesn't become `foo--bar`.
			//   - Strip leading/trailing `-` so `_foo_` doesn't become `-foo-`.
			//   - Prepend `pkg-` when the slug starts with a digit (npm scope
			//     rules + MVR convention treat digit-leading names as
			//     suspicious).
			//   - Fall back to `pkg` when the slug collapses to empty (a name
			//     consisting only of separators like `___`).
			const mvrSlug = (() => {
				let s = options.name
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, '-')
					.replace(/-+/g, '-')
					.replace(/^-+|-+$/g, '');
				if (s.length === 0) s = 'pkg';
				if (/^[0-9]/.test(s)) s = `pkg-${s}`;
				return s;
			})();
			const mvrPlaceholder = options.mvrPlaceholder ?? `@local/${mvrSlug}`;
			const sourceHash = yield* hashMoveSources(options.path);
			const cacheKey = `publishMove/v2/${options.name}/${sourceHash}/${sui.chainId}`;
			const cached = yield* state.get<Package<TCaptured>>(cacheKey);
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
				const hit: Package<TCaptured> = {
					...cached.value,
					sourcePath: options.path,
					mvrPlaceholder,
				};
				// Re-register on every run — registries live in-memory per
				// engine invocation and a cache hit must still surface the
				// package + coins to downstream consumers (mvr resolver,
				// status command, etc.).
				yield* publishPackage({
					name: options.name,
					packageId: hit.packageId,
					upgradeCapId: hit.upgradeCapId,
					mvrPlaceholder,
					captured: hit.captured as Record<string, unknown> | undefined,
				});
				for (const coin of Object.values(hit.coins) as ReadonlyArray<PublishedCoin>) {
					yield* publishCoin({
						name: coin.name,
						type: coin.fullCoinType,
						decimals: coin.decimals,
						sdkCoin: coin.sdkCoin,
						...(coin.symbol !== undefined ? { symbol: coin.symbol } : {}),
						...(coin.displayName !== undefined ? { displayName: coin.displayName } : {}),
						...(coin.iconUrl !== undefined ? { iconUrl: coin.iconUrl } : {}),
						...(coin.treasuryCapId !== undefined ? { treasuryCapId: coin.treasuryCapId } : {}),
						...(coin.metadataId !== undefined ? { metadataId: coin.metadataId } : {}),
						...(coin.packageId !== undefined ? { packageId: coin.packageId } : {}),
					});
				}
				yield* registerMintStrategies(signer, Object.values(hit.coins));
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
							phase: 'scrub',
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
							phase: 'build',
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
							phase: 'publish-tx',
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
						phase: 'parse',
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
				// Phase -1 (gRPC migration): the gRPC `client.core.getObject(
				// {objectId})` throws when the fullnode hasn't ingested the
				// publish checkpoint yet, instead of the JSON-RPC tagged
				// `{error: 'notExists', data: undefined}` payload. The
				// surrounding retry/timeout pipeline below already handles
				// the failure case identically to the old "tagged-error"
				// branch, so we just let `tryPromise` capture the throw.
				yield* Effect.tryPromise({
					try: () => sui.client.core.getObject({ objectId: packageId }),
					catch: (cause) => new Error(`package not yet on-chain: ${String(cause)}`),
				});
			}).pipe(
				Effect.retry(Schedule.spaced('200 millis')),
				Effect.timeoutOrElse({
					duration: '10 seconds',
					orElse: () =>
						Effect.fail(
							new PublishError({
								phase: 'parse',
								message: `publishMove(${options.name}): publish tx succeeded but package ${packageId} did not become queryable within 10s`,
							}),
						),
				}),
			);

			const upgradeCapId = pickCreatedByType(result.objectChanges, {
				suffix: UPGRADE_CAP_TYPE_SUFFIX,
			});

			const captured = options.capture ? options.capture(result.objectChanges) : undefined;

			// Coin auto-discovery is the single source. Every coin the
			// publish receipt creates surfaces as a `PublishedCoin` entry
			// keyed by the on-chain CoinMetadata symbol (when present) or
			// the witness type name (when the publish didn't follow the
			// standard `coin::create_currency` pattern).
			const discovered = discoverCoinsFromPublish(result.objectChanges, signer.address);

			// Fetch CoinMetadata for every discovered coin. One concurrent
			// RPC batch; on transient failure individual entries degrade to
			// "no metadata" and the publishMove pipeline keeps going.
			const allCoinTypes = discovered.map((d) => d.coinType);
			const metadataByType: ReadonlyMap<string, OnchainCoinMetadata> =
				allCoinTypes.length > 0
					? yield* fetchCoinMetadataMany(sui.client, allCoinTypes)
					: new Map();

			const coins = {} as Record<string, PublishedCoin>;
			for (const disc of discovered) {
				const md = metadataByType.get(disc.coinType);
				// Symbol-keyed naming: prefer the on-chain CoinMetadata
				// symbol; fall back to the coin's witness type name when
				// the publish didn't emit a CoinMetadata. Either form is
				// addressable through `Coin('SYMBOL')` (case-insensitive
				// lookup against both the symbol and the witness).
				const key =
					md?.symbol !== undefined && md.symbol.length > 0 ? md.symbol : disc.witnessName;
				// Decimals authority: on-chain RPC value; falls back to 0
				// when the coin didn't emit a CoinMetadata (rare custom
				// init bypassing `coin::create_currency`).
				const decimals = md?.decimals ?? 0;
				const coin: PublishedCoin = {
					name: key,
					module: disc.moduleName,
					type: disc.witnessName,
					decimals,
					fullCoinType: disc.coinType,
					sdkCoin: toSdkCoin({ fullCoinType: disc.coinType, decimals }),
					packageId,
					...(disc.treasuryCapId !== undefined ? { treasuryCapId: disc.treasuryCapId } : {}),
					...(disc.treasuryCapOwner !== undefined
						? { treasuryCapOwner: disc.treasuryCapOwner }
						: {}),
					publisherOwnsCap: disc.publisherOwnsCap,
					...(disc.metadataId !== undefined ? { metadataId: disc.metadataId } : {}),
					...(md?.symbol !== undefined && md.symbol.length > 0
						? { symbol: md.symbol }
						: {}),
					...(md?.name !== undefined && md.name.length > 0
						? { displayName: md.name }
						: {}),
					...(md?.iconUrl !== undefined ? { iconUrl: md.iconUrl } : {}),
				};
				// Collision guard: two coins in one package publishing the
				// same on-chain symbol. Discovery sorts deterministically
				// by coinType so the second occurrence is dropped with a
				// warning — this is a Move-source bug the developer
				// should fix (each coin's CoinMetadata symbol should be
				// unique within a package).
				if (coins[key] !== undefined) {
					yield* Effect.logWarning(
						`publishMove(${options.name}): coin key collision on '${key}' (existing: ${coins[key].fullCoinType}, ` +
							`incoming: ${coin.fullCoinType}) — keeping the first. Each coin's CoinMetadata ` +
							`symbol should be unique within a package.`,
					);
					continue;
				}
				coins[key] = coin;
			}

			yield* publishPackage({
				name: options.name,
				packageId,
				upgradeCapId,
				mvrPlaceholder,
				captured: captured as Record<string, unknown> | undefined,
			});

			for (const coin of Object.values(coins)) {
				yield* publishCoin({
					name: coin.name,
					type: coin.fullCoinType,
					decimals: coin.decimals,
					sdkCoin: coin.sdkCoin,
					...(coin.symbol !== undefined ? { symbol: coin.symbol } : {}),
					...(coin.displayName !== undefined ? { displayName: coin.displayName } : {}),
					...(coin.iconUrl !== undefined ? { iconUrl: coin.iconUrl } : {}),
					...(coin.treasuryCapId !== undefined ? { treasuryCapId: coin.treasuryCapId } : {}),
					...(coin.metadataId !== undefined ? { metadataId: coin.metadataId } : {}),
					...(coin.packageId !== undefined ? { packageId: coin.packageId } : {}),
				});
			}
			yield* registerMintStrategies(signer, Object.values(coins));

			const result_: Package<TCaptured> = {
				name: options.name,
				packageId,
				upgradeCapId,
				captured: captured as TCaptured,
				coins,
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
			plugin: 'move',
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
