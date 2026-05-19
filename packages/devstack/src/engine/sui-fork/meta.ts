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
//   └── sui-fork-cache/<chainId>/       # shared, refcounted upstream cache
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

import { createHash } from 'node:crypto';
import { join as joinPath } from 'node:path';
import { Effect, FileSystem, Schema } from 'effect';
import { writeFileAtomicIfChanged } from '../atomic-write.js';
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
});
export type ForkMeta = typeof ForkMeta.Type;

export interface ForkConfigInput {
	readonly upstream: string;
	readonly checkpoint?: number;
	readonly seedAddresses: ReadonlyArray<string>;
	readonly seedObjects: ReadonlyArray<string>;
}

/** Canonical config digest. Stable across orderings of `seedAddresses` /
 *  `seedObjects`. */
export const computeConfigHash = (input: ForkConfigInput): string => {
	const norm = (s: string) => s.toLowerCase();
	const addresses = [...input.seedAddresses].map(norm).sort();
	const objects = [...input.seedObjects].map(norm).sort();
	const payload = JSON.stringify({
		upstream: input.upstream,
		checkpoint: input.checkpoint ?? null,
		seedAddresses: addresses,
		seedObjects: objects,
	});
	return createHash('sha256').update(payload).digest('hex').slice(0, 16);
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
}): Effect.Effect<
	{ written: boolean; meta: ForkMeta },
	SeedManifestMismatchError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const existing = yield* readForkMeta(args.metaPath);
		const currentHash = computeConfigHash(args.current);
		if (existing !== undefined) {
			if (existing.configHash === currentHash) {
				return { written: false, meta: existing };
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
		};
		yield* writeForkMeta(args.metaPath, meta);
		return { written: true, meta };
	});
