// Per-stack fork meta.json — config-hash gate that mirrors `sui-fork`'s
// write-once seed-manifest contract (R6 mitigation).
//
// Path layout (Phase 4 P4.15):
//
//   .devstack/
//   ├── stacks/<stack>/
//   │   └── sui-fork/
//   │       ├── data/                   # per-stack mutable fork state
//   │       ├── seed-manifest.json      # written by sui-fork itself
//   │       ├── meta.json               # written by devstack apply
//   │       └── data.lock               # file-lock acquired by buildFork
//   └── sui-fork-cache/<chainId>/       # shared upstream cache, manual GC
//
// Cache GC: the upstream cache directory is shared across every stack on
// the same chainId but is NOT refcounted. Cleanup is manual: users reach
// for `devstack fork cache prune --unreferenced` (drops cache entries no
// longer referenced by any live stack's meta.json) or
// `devstack wipe --also-upstream-cache` (nukes the whole cache root)
// when disk pressure matters. We considered refcount and age-based
// eviction (post-launch-sweep §3.6/F18); both add cycle-time bookkeeping
// for a problem that hasn't materialized in practice — the cache is
// small (~MBs per chain), users rarely accumulate >2 forked chains, and
// nuking it is a no-data-loss operation (the next `apply` re-acquires
// from upstream). Settled as manual-only on 2026-05-19; re-evaluate if
// the cache grows beyond a real pain threshold.
//
// `meta.json` is written ONCE on first boot of a fork stack with a
// `configHash` of the relevant `SuiForkOptions` fields. On subsequent
// boots, devstack compares the current config's hash against the on-disk
// hash; a mismatch raises `SeedManifestMismatchError` BEFORE we hand the
// data dir to sui-fork (which would otherwise fail inside the binary
// with a non-actionable Rust panic message — see R6).
//
// `configHash` covers:
//   - `upstream` network literal (`mainnet` / `testnet` / `devnet`)
//   - `checkpoint` (the upstream checkpoint anchor)
//   - sorted `seed.addresses` (impersonation seed set)
//   - sorted `seed.objects` (object-id seeds)
//
// `image` / `version` / `defaultGasBudget` / `readyTimeoutMs` are
// deliberately excluded: changing the image tag doesn't change the
// fork's on-disk state shape, and changing the gas budget / probe
// budget is a supervisor concern that doesn't affect what's already
// been persisted in the data dir.
//
// Runtime carry (Phase 5 P5.5.4): the `runtime` sub-record holds
// values that should *persist across resume* but are deliberately
// NOT part of the seed-manifest contract — changing them does not
// invalidate the on-disk data dir. The canonical example is
// `autoTickMs`: the supervisor's auto-tick fiber is ephemeral, but
// recording the configured cadence lets a resume restore the same
// cadence when the caller didn't re-pass `autoTick` (e.g. `devstack
// fork up --detached` followed by a bare `devstack up` from a sibling
// process). The `runtime` sub-record is excluded from `configHash`
// so flipping `autoTickMs` from 1000 → 2000 does NOT raise
// `SeedManifestMismatchError`.

import { join as joinPath } from 'node:path';
import { Effect, FileSystem, Schema } from 'effect';
import { writeFileAtomicIfChanged } from '../atomic-write.js';
import { contentHash } from '../content-hash.js';
import { SeedManifestMismatchError } from '../errors.js';
import { resolveAppDir } from '../resolve-app-dir.js';

/** v1 of the fork meta schema. Field naming mirrors `SnapshotMeta` so
 *  the snapshot-restore path can echo identical fields back during the
 *  fork integrity gate. */
export const ForkMeta = Schema.Struct({
	version: Schema.Literal(1),
	/** Wall-clock at first-boot acquire. Carried for debuggability —
	 *  doctor surfaces it as part of the meta block. */
	createdAt: Schema.Number,
	/** Upstream network literal (mainnet / testnet / devnet). */
	upstream: Schema.String,
	/** Upstream checkpoint the fork was anchored at, when the user pinned
	 *  one explicitly. `undefined` means the fork acquired at the
	 *  upstream's then-latest checkpoint and the actual anchor is
	 *  recorded inside `seed-manifest.json` (which devstack does NOT
	 *  re-read — sui-fork owns that file's contents). */
	checkpoint: Schema.optional(Schema.Number),
	/** Sorted, lowercased seed addresses. The sort is canonical so two
	 *  configs that pass the same addresses in different orders produce
	 *  the same `configHash`. */
	seedAddresses: Schema.Array(Schema.String),
	/** Sorted, lowercased seed object ids. */
	seedObjects: Schema.Array(Schema.String),
	/** Pre-computed digest of `(upstream, checkpoint, seedAddresses,
	 *  seedObjects)` — the value compared on subsequent boots. */
	configHash: Schema.String,
	/** Runtime-only carry. Persisted alongside the seed-manifest fields
	 *  so a resume can recover supervisor-side state (e.g. auto-tick
	 *  cadence) that isn't part of the on-disk data dir's contract.
	 *  *Excluded from `configHash`* — see `computeConfigHash` below. */
	runtime: Schema.optional(
		Schema.Struct({
			/** Auto-tick cadence in ms (Phase 5 Subtopic 3 / P5.5.4).
			 *  Written at first-boot acquire when `Sui({fork:{autoTick}})`
			 *  resolves to a positive interval; read back on resume when
			 *  the caller did NOT re-pass `autoTick` so the cadence
			 *  survives `devstack up` cycles. */
			autoTickMs: Schema.optional(Schema.Number),
		}),
	),
});
export type ForkMeta = typeof ForkMeta.Type;

export interface ForkConfigInput {
	readonly upstream: string;
	readonly checkpoint?: number;
	readonly seedAddresses: ReadonlyArray<string>;
	readonly seedObjects: ReadonlyArray<string>;
}

/** Runtime carry input — values folded into `ForkMeta.runtime` at
 *  first-boot OR refreshed in-place on subsequent boots. Excluded from
 *  `configHash` (mutating these fields does NOT trip
 *  `SeedManifestMismatchError`). */
export interface ForkRuntimeInput {
	/** Resolved auto-tick cadence in ms. `undefined` means "no auto-tick
	 *  this boot"; the persisted value is cleared accordingly so a
	 *  resume doesn't re-arm a cadence the caller explicitly turned off. */
	readonly autoTickMs?: number;
}

/** Canonical config digest. Stable across orderings of `seedAddresses` /
 *  `seedObjects`. */
export const computeConfigHash = (input: ForkConfigInput): string => {
	const norm = (s: string) => s.toLowerCase();
	const addresses = [...input.seedAddresses].map(norm).sort();
	const objects = [...input.seedObjects].map(norm).sort();
	// Pre-stringify so the helper hashes the exact bytes we've canonicalized
	// (sorted, lowercased) rather than re-running JSON.stringify with
	// potentially-different key order via the object overload.
	const payload = JSON.stringify({
		upstream: input.upstream,
		checkpoint: input.checkpoint ?? null,
		seedAddresses: addresses,
		seedObjects: objects,
	});
	return contentHash(payload, { length: 16 });
};

/** Resolve `.devstack/stacks/<stack>/sui-fork/meta.json` for the given
 *  stack identity. Mirrors `state-store.ts:resolvePaths` so the meta
 *  lives alongside the data dir + lock. */
export const resolveForkMetaPath = (stack: string, appDir?: string): string => {
	const root = appDir ?? resolveAppDir();
	return joinPath(root, '.devstack', 'stacks', stack, 'sui-fork', 'meta.json');
};

export const resolveForkDataDir = (stack: string, appDir?: string): string => {
	const root = appDir ?? resolveAppDir();
	return joinPath(root, '.devstack', 'stacks', stack, 'sui-fork', 'data');
};

const decodeMeta = Schema.decodeUnknownSync(ForkMeta);
const encodeMeta = Schema.encodeUnknownSync(ForkMeta);

/** Try to read + decode an existing meta.json. Returns `undefined`
 *  when the file is missing or the body is corrupt; callers treat both
 *  as "first boot" (`writeForkMeta` then plants a fresh file). */
export const readForkMeta = (
	metaPath: string,
): Effect.Effect<ForkMeta | undefined, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const exists = yield* fs.exists(metaPath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return undefined;
		const raw = yield* fs.readFileString(metaPath).pipe(Effect.orElseSucceed(() => ''));
		if (raw.trim().length === 0) return undefined;
		try {
			const parsed = JSON.parse(raw) as unknown;
			return decodeMeta(parsed);
		} catch {
			return undefined;
		}
	});

/** First-boot writer. Idempotent at the byte level (atomic-if-changed). */
export const writeForkMeta = (metaPath: string, meta: ForkMeta): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () => writeFileAtomicIfChanged(metaPath, JSON.stringify(encodeMeta(meta), null, 2)),
		catch: (cause) => new Error(`writeForkMeta: ${String(cause)}`),
	}).pipe(Effect.asVoid, Effect.orDie);

/**
 * On every fork-mode acquire: compare the current config against the
 * persisted meta. Three outcomes:
 *
 *   1. No on-disk meta → first boot, write a fresh one + return.
 *   2. On-disk meta `configHash === current` → resume, no-op.
 *   3. Mismatch → raise `SeedManifestMismatchError` with both snapshots
 *      so the CLI can surface a structured diff + actionable recipe.
 */
export const ensureForkMetaConsistent = (args: {
	readonly metaPath: string;
	readonly current: ForkConfigInput;
	/** Runtime carry to persist on first boot OR refresh on resume.
	 *  Mutating values inside `runtime` does NOT change `configHash` —
	 *  this is the carry slot for supervisor-side cadence values
	 *  (`autoTickMs`) that should survive `devstack up` cycles without
	 *  re-flighting the seed-manifest gate. */
	readonly runtime?: ForkRuntimeInput;
}): Effect.Effect<
	{ written: boolean; meta: ForkMeta },
	SeedManifestMismatchError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const existing = yield* readForkMeta(args.metaPath);
		const currentHash = computeConfigHash(args.current);
		const nextRuntime = buildRuntime(args.runtime);
		if (existing !== undefined) {
			if (existing.configHash === currentHash) {
				// configHash matches → resume path. Refresh the runtime
				// carry if it drifted (e.g. caller passed a new
				// `autoTickMs`, or cleared it). The configHash itself is
				// unchanged so the seed-manifest contract holds.
				if (runtimeEquals(existing.runtime, nextRuntime)) {
					return { written: false, meta: existing };
				}
				const refreshed: ForkMeta = {
					...existing,
					...(nextRuntime !== undefined ? { runtime: nextRuntime } : {}),
				};
				// Strip the `runtime` key entirely when the caller cleared
				// it — `Schema.optional` round-trips by absence, not by an
				// explicit `undefined`, so leaving the key on the object
				// would be a schema-shape mismatch downstream.
				if (nextRuntime === undefined && 'runtime' in refreshed) {
					delete (refreshed as { runtime?: unknown }).runtime;
				}
				yield* writeForkMeta(args.metaPath, refreshed);
				return { written: true, meta: refreshed };
			}
			return yield* Effect.fail(
				new SeedManifestMismatchError({
					metaPath: args.metaPath,
					message:
						`fork meta at ${args.metaPath} disagrees with the current Sui({fork:{…}}) ` +
						`configuration. The on-disk data dir was seeded with a different upstream / ` +
						`checkpoint / seed set, and re-booting against the current config would ` +
						`silently diverge from sui-fork's write-once seed manifest. Resolve by ` +
						`running \`devstack wipe --keep-upstream-cache && devstack apply\` to wipe ` +
						`the per-stack fork state (the shared .devstack/sui-fork-cache/ stays so ` +
						`the next boot doesn't re-download the upstream system state from scratch).`,
					previous: {
						upstream: existing.upstream,
						...(existing.checkpoint !== undefined ? { checkpoint: existing.checkpoint } : {}),
						configHash: existing.configHash,
					},
					current: {
						upstream: args.current.upstream,
						...(args.current.checkpoint !== undefined
							? { checkpoint: args.current.checkpoint }
							: {}),
						configHash: currentHash,
					},
				}),
			);
		}
		const meta: ForkMeta = {
			version: 1,
			createdAt: Date.now(),
			upstream: args.current.upstream,
			...(args.current.checkpoint !== undefined ? { checkpoint: args.current.checkpoint } : {}),
			seedAddresses: [...args.current.seedAddresses].map((s) => s.toLowerCase()).sort(),
			seedObjects: [...args.current.seedObjects].map((s) => s.toLowerCase()).sort(),
			configHash: currentHash,
			...(nextRuntime !== undefined ? { runtime: nextRuntime } : {}),
		};
		yield* writeForkMeta(args.metaPath, meta);
		return { written: true, meta };
	});

/** Normalise the caller's runtime input into the persisted shape, or
 *  `undefined` when no runtime carry is needed. Centralised so first-
 *  boot writes and resume-refreshes hit identical canonicalisation. */
const buildRuntime = (input: ForkRuntimeInput | undefined): ForkMeta['runtime'] | undefined => {
	if (input === undefined) return undefined;
	const fields: { autoTickMs?: number } = {};
	if (input.autoTickMs !== undefined && Number.isFinite(input.autoTickMs) && input.autoTickMs > 0) {
		fields.autoTickMs = input.autoTickMs;
	}
	// Empty record → treat as "no runtime carry" so the persisted shape
	// stays minimal (avoids writing `{runtime: {}}` to disk).
	return Object.keys(fields).length === 0 ? undefined : fields;
};

/** Deep-equality on the optional runtime sub-record. Both sides may be
 *  `undefined`; treat identical-by-value as equal so a no-op resume
 *  stays a no-op. */
const runtimeEquals = (
	a: ForkMeta['runtime'] | undefined,
	b: ForkMeta['runtime'] | undefined,
): boolean => {
	if (a === undefined && b === undefined) return true;
	if (a === undefined || b === undefined) return false;
	return a.autoTickMs === b.autoTickMs;
};
