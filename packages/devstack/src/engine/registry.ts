// Global devstack registry — the file the rest of the toolchain reads to
// answer "what stacks exist on this machine, regardless of whether their
// repo is still on disk?". The doctor + prune CLI use this so cleanup
// keeps working after a developer has `rm -rf`'d an example repo
// without first running `wipe`.
//
// Location: `~/.devstack/registry.json` (top-level home — same shape
// most CLIs use for global state: ~/.aws, ~/.docker, ~/.npm, etc.).
// Permissions: 0644 on the file, 0755 on the parent dir. The file is
// machine-local (no secrets) and read by every supervisor on the host,
// so it doesn't get the 0600 lockdown the per-stack state files get.
//
// Concurrency model — two `pnpm dev` against different stacks must be
// able to upsert the registry simultaneously without one losing its
// entry. Mirrors the protocol in `state-store.ts`:
//   1. Read the file (best-effort; empty if missing).
//   2. Apply the mutation in memory.
//   3. `writeFileString(tmp, body)` then `rename(tmp, registry.json)` —
//      POSIX rename is atomic so a concurrent reader never sees a
//      partial file. Tempfile name carries pid + timestamp + random so
//      two writers can't collide on the temp path.
//   4. Last-write-wins by design. The window between step 1 and step 3
//      is tiny (a few milliseconds) and the cost of a stale write
//      losing one entry is small (the losing supervisor will re-upsert
//      itself on the next iteration of its own loop).
//
// Schema-versioned. v1 is the only shape today; a future bump migrates
// in-place from inside `read`. Higher-than-current versions fail loudly
// (the user has a newer devstack on the same machine).
//
// All registry I/O is **best-effort** from the supervisor's POV: a
// failed write must NEVER block stack boot or teardown. Callers wrap
// `upsert` / `clearPid` / `remove` in `Effect.ignore` (see
// `define-devstack.ts` + `_prune-stack.ts`).

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context, Effect, FileSystem, Layer, PlatformError, Schedule } from 'effect';
import { isPidAlive } from './process-liveness.js';

export type RegistryNetwork = 'localnet' | 'testnet' | 'mainnet' | 'custom';

export interface RegistryEntry {
	readonly app: string;
	readonly stack: string;
	readonly network: RegistryNetwork;
	readonly repoPath: string;
	readonly firstSeen: string;
	readonly lastSeen: string;
	readonly chainId?: string;
	readonly pid?: number;
}

export interface RegistryFile {
	readonly version: 1;
	readonly stacks: ReadonlyArray<RegistryEntry>;
}

export type Classification = 'active' | 'dormant' | 'stale' | 'abandoned';

const CURRENT_VERSION = 1 as const;

// Override knob for tests — set `DEVSTACK_REGISTRY_FILE=/tmp/foo.json`
// and the registry I/O runs against that path instead of `~/.devstack/`.
// Honors the same precedence as the per-stack state store's
// `DEVSTACK_STATE_DIR` escape hatch.
export const registryFilePath = (): string => {
	const override = process.env.DEVSTACK_REGISTRY_FILE;
	if (override !== undefined && override.length > 0) return override;
	return join(homedir(), '.devstack', 'registry.json');
};

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const emptyRegistry = (): RegistryFile => ({ version: CURRENT_VERSION, stacks: [] });

const sameStack = (
	a: { readonly app: string; readonly stack: string; readonly network: string },
	b: { readonly app: string; readonly stack: string; readonly network: string },
): boolean => a.app === b.app && a.stack === b.stack && a.network === b.network;

// Decide an entry's lifecycle bucket. See `Classification` for the bucket
// vocabulary. Pure for testability; no fs / clock dependency other than
// the injected `now` for `stale` cut-off.
export const classifyEntry = (
	entry: RegistryEntry,
	options: {
		readonly now?: number;
		readonly repoExists?: (path: string) => boolean;
		readonly pidAlive?: (pid: number) => boolean;
	} = {},
): Classification => {
	const repoExists = options.repoExists ?? existsSync;
	const pidAlive = options.pidAlive ?? isPidAlive;
	const now = options.now ?? Date.now();

	if (entry.pid !== undefined && pidAlive(entry.pid)) return 'active';
	if (!repoExists(entry.repoPath)) return 'abandoned';

	const lastSeenMs = Date.parse(entry.lastSeen);
	if (!Number.isFinite(lastSeenMs)) return 'dormant';
	if (now - lastSeenMs > STALE_THRESHOLD_MS) return 'stale';
	return 'dormant';
};

// Validate a JSON-parsed registry candidate, dropping malformed entries
// rather than failing the read. Registry reads are best-effort: a
// corrupt-by-hand entry should fall to the floor, not crash supervisor
// boot. Same defensive load shape as `state-store.ts`.
const parseRegistry = (raw: string): RegistryFile => {
	if (raw.trim().length === 0) return emptyRegistry();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyRegistry();
	}
	if (parsed === null || typeof parsed !== 'object') return emptyRegistry();
	const obj = parsed as { version?: unknown; stacks?: unknown };
	if (obj.version !== CURRENT_VERSION) return emptyRegistry();
	if (!Array.isArray(obj.stacks)) return emptyRegistry();
	const stacks: Array<RegistryEntry> = [];
	for (const candidate of obj.stacks) {
		if (candidate === null || typeof candidate !== 'object') continue;
		const c = candidate as Record<string, unknown>;
		if (typeof c.app !== 'string' || c.app.length === 0) continue;
		if (typeof c.stack !== 'string' || c.stack.length === 0) continue;
		if (typeof c.network !== 'string') continue;
		if (typeof c.repoPath !== 'string') continue;
		if (typeof c.firstSeen !== 'string') continue;
		if (typeof c.lastSeen !== 'string') continue;
		const network = c.network as RegistryNetwork;
		if (
			network !== 'localnet' &&
			network !== 'testnet' &&
			network !== 'mainnet' &&
			network !== 'custom'
		) {
			continue;
		}
		const entry: RegistryEntry = {
			app: c.app,
			stack: c.stack,
			network,
			repoPath: c.repoPath,
			firstSeen: c.firstSeen,
			lastSeen: c.lastSeen,
			...(typeof c.chainId === 'string' ? { chainId: c.chainId } : {}),
			...(typeof c.pid === 'number' && Number.isFinite(c.pid) ? { pid: c.pid } : {}),
		};
		stacks.push(entry);
	}
	return { version: CURRENT_VERSION, stacks };
};

export interface UpsertInput {
	readonly app: string;
	readonly stack: string;
	readonly network: RegistryNetwork;
	readonly repoPath: string;
	readonly pid?: number;
	readonly chainId?: string;
}

export interface RegistryShape {
	readonly read: Effect.Effect<RegistryFile>;
	/** Insert a new entry or refresh `lastSeen` / `pid` / `chainId` on an existing one. */
	readonly upsert: (input: UpsertInput) => Effect.Effect<void>;
	/** Strip the `pid` field on clean shutdown so classify() drops the row out of `active`. */
	readonly clearPid: (app: string, stack: string, network: RegistryNetwork) => Effect.Effect<void>;
	/** Drop the entry entirely — called by `wipe` / `prune` after teardown. */
	readonly remove: (app: string, stack: string, network: RegistryNetwork) => Effect.Effect<void>;
}

export class Registry extends Context.Service<Registry, RegistryShape>()('@devstack/Registry') {}

// Read-modify-write loop. Bounded retries on transient errors (rename
// race, temp-path collision). The window between read and write is
// small; under normal conditions we hit the success path on the first
// attempt.
const MAX_WRITE_ATTEMPTS = 3;

export const RegistryLive: Layer.Layer<Registry, never, FileSystem.FileSystem> = Layer.effect(
	Registry,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const read: Effect.Effect<RegistryFile> = Effect.gen(function* () {
			const path = registryFilePath();
			const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
			if (!exists) return emptyRegistry();
			const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ''));
			return parseRegistry(raw);
		});

		const writeOnce = (next: RegistryFile): Effect.Effect<void, PlatformError.PlatformError> =>
			Effect.gen(function* () {
				const path = registryFilePath();
				const dir = dirname(path);
				yield* fs.makeDirectory(dir, { recursive: true, mode: 0o755 }).pipe(Effect.ignore);
				// Same tempfile + rename protocol as state-store. Random suffix
				// guards two writers in different processes with the same pid
				// space (e.g. inside a container) from colliding on the temp path.
				const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
				const body = `${JSON.stringify(next, null, 2)}\n`;
				yield* fs.writeFileString(tmp, body, { mode: 0o644 });
				yield* fs
					.rename(tmp, path)
					.pipe(Effect.tapError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)));
				yield* fs.chmod(path, 0o644).pipe(Effect.ignore);
			});

		const mutate = (mutator: (current: RegistryFile) => RegistryFile): Effect.Effect<void> =>
			read.pipe(
				Effect.flatMap((current) => writeOnce(mutator(current))),
				Effect.retry(Schedule.recurs(MAX_WRITE_ATTEMPTS - 1)),
				Effect.orDie,
			);

		const upsert: RegistryShape['upsert'] = (input) =>
			mutate((current) => {
				const now = new Date().toISOString();
				const existing = current.stacks.find((e) => sameStack(e, input));
				const merged: RegistryEntry = {
					app: input.app,
					stack: input.stack,
					network: input.network,
					repoPath: input.repoPath,
					firstSeen: existing?.firstSeen ?? now,
					lastSeen: now,
					...(input.chainId !== undefined
						? { chainId: input.chainId }
						: existing?.chainId !== undefined
							? { chainId: existing.chainId }
							: {}),
					...(input.pid !== undefined ? { pid: input.pid } : {}),
				};
				const stacks: Array<RegistryEntry> = current.stacks
					.filter((e) => !sameStack(e, input))
					.concat(merged);
				return { version: CURRENT_VERSION, stacks };
			});

		const clearPid: RegistryShape['clearPid'] = (app, stack, network) =>
			mutate((current) => {
				const stacks = current.stacks.map((e) => {
					if (!sameStack(e, { app, stack, network })) return e;
					const { pid: _drop, ...rest } = e;
					return rest as RegistryEntry;
				});
				return { version: CURRENT_VERSION, stacks };
			});

		const remove: RegistryShape['remove'] = (app, stack, network) =>
			mutate((current) => ({
				version: CURRENT_VERSION,
				stacks: current.stacks.filter((e) => !sameStack(e, { app, stack, network })),
			}));

		return { read, upsert, clearPid, remove };
	}),
);
