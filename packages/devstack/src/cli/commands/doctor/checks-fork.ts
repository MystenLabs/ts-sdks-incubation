// Fork-specific doctor checks (P4.11-P4.14).
//
// Each is a no-op when no fork stacks are present on disk; otherwise:
//   - P4.11 — `sui-fork --version` shell-out (informational unless the
//     host has a local build).
//   - P4.12 — TCP probe of upstream GraphQL endpoints.
//   - P4.13 — meta.json configHash self-consistency.
//   - P4.14 — per-stack fork data dir size.

import { Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Socket } from 'node:net';
import { join as joinPath } from 'node:path';
import { formatBytes } from '../../../engine/docker/inventory.js';
import { safeDirSize } from '../../../engine/fs-utils.js';
import { computeConfigHash, readForkMeta } from '../../../engine/sui-fork/meta.js';
import type { Check } from './_check.js';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

/** Best-effort discovery of every fork-mode stack on disk. Walks
 *  `.devstack/stacks/* /sui-fork/meta.json` and returns the per-stack
 *  meta + path tuples. Used by the four P4.11-P4.14 checks; an empty
 *  array means "no fork stacks", and the doctor section quietly omits
 *  those rows. */
export interface ForkStackEntry {
	readonly stack: string;
	readonly metaPath: string;
	readonly dataDir: string;
	readonly upstream: string;
	readonly checkpoint?: number;
	readonly seedAddresses: ReadonlyArray<string>;
	readonly seedObjects: ReadonlyArray<string>;
	readonly configHash: string;
}

export const discoverForkStacks = (fs: FileSystem.FileSystem, stateDirPath: string) =>
	Effect.gen(function* () {
		const stacksDir = joinPath(stateDirPath, 'stacks');
		const entries = yield* fs
			.readDirectory(stacksDir)
			.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
		const out: Array<ForkStackEntry> = [];
		for (const stack of entries) {
			const metaPath = joinPath(stacksDir, stack, 'sui-fork', 'meta.json');
			const dataDir = joinPath(stacksDir, stack, 'sui-fork', 'data');
			const meta = yield* readForkMeta(metaPath);
			if (meta === undefined) continue;
			out.push({
				stack,
				metaPath,
				dataDir,
				upstream: meta.upstream,
				...(meta.checkpoint !== undefined ? { checkpoint: meta.checkpoint } : {}),
				seedAddresses: meta.seedAddresses,
				seedObjects: meta.seedObjects,
				configHash: meta.configHash,
			});
		}
		return out as ReadonlyArray<ForkStackEntry>;
	});

// P4.11 — `sui-fork --version` shell-out. Required when at least one
// fork stack exists, informational otherwise. The binary is the
// devstack-vendored `sui-fork` (lives inside the per-stack docker
// image), so a missing host binary is expected — the check is more
// useful for users who built sui-fork locally and put it on PATH.
export const checkSuiForkBinary = (
	spawner: Spawner,
	required: boolean,
): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('sui-fork', ['--version']);
		const out = yield* spawner.string(cmd).pipe(
			Effect.map((s) => ({ ok: true, text: s.trim() })),
			Effect.catch((err) => Effect.succeed({ ok: false, text: String(err) })),
		);
		if (!out.ok) {
			return {
				name: 'sui-fork binary',
				ok: false,
				required,
				detail: out.text.includes('ENOENT')
					? 'sui-fork not found on PATH (devstack uses the vendored container binary, so this is informational unless you build sui-fork locally)'
					: `\`sui-fork --version\` failed: ${out.text}`,
			};
		}
		return { name: 'sui-fork binary', ok: true, required, detail: out.text };
	});

// P4.12 — upstream GraphQL reachability. Informational: a fork stack
// boot needs reachable upstream GraphQL (R2), but a transient blip
// doesn't warrant failing doctor. TCP probe of the documented endpoint
// hostnames per upstream.
const TCP_PROBE_TIMEOUT_MS = 2000;
const tcpProbe = (host: string, port: number): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const socket = new Socket();
		socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
		let done = false;
		const finalize = (ok: boolean) => {
			if (done) return;
			done = true;
			socket.destroy();
			resume(Effect.succeed(ok));
		};
		socket.once('connect', () => finalize(true));
		socket.once('timeout', () => finalize(false));
		socket.once('error', () => finalize(false));
		socket.connect(port, host);
	});

const upstreamGraphqlHost = (upstream: string): string => {
	if (upstream === 'mainnet') return 'fullnode.mainnet.sui.io';
	if (upstream === 'testnet') return 'fullnode.testnet.sui.io';
	if (upstream === 'devnet') return 'fullnode.devnet.sui.io';
	return `fullnode.${upstream}.sui.io`;
};

export const checkUpstreamGraphql = (
	upstreams: ReadonlyArray<string>,
): Effect.Effect<Check> =>
	Effect.gen(function* () {
		if (upstreams.length === 0) {
			return {
				name: 'upstream GraphQL',
				ok: true,
				required: false,
				detail: 'no fork stacks — skipped',
			};
		}
		const results: Array<{ upstream: string; ok: boolean }> = [];
		for (const u of upstreams) {
			const host = upstreamGraphqlHost(u);
			const ok = yield* tcpProbe(host, 443);
			results.push({ upstream: u, ok });
		}
		const failed = results.filter((r) => !r.ok);
		if (failed.length === 0) {
			return {
				name: 'upstream GraphQL',
				ok: true,
				required: false,
				detail: `reachable: ${results.map((r) => r.upstream).join(', ')}`,
			};
		}
		return {
			name: 'upstream GraphQL',
			ok: false,
			required: false,
			detail:
				`unreachable: ${failed.map((r) => r.upstream).join(', ')} ` +
				`(TCP :443 probe failed within ${TCP_PROBE_TIMEOUT_MS}ms)`,
		};
	});

// P4.13 — seed manifest matches config. Read each stack's meta.json
// and compare against itself (self-consistency check — the configHash
// must agree with the live `computeConfigHash(...)` of the persisted
// fields). Doesn't have access to the user's `devstack.config.ts`
// from inside doctor, so this surfaces corruption / tampering rather
// than runtime-vs-config drift. Drift detection runs at `apply` time
// (`ensureForkMetaConsistent`).
export const checkSeedManifests = (
	stacks: ReadonlyArray<ForkStackEntry>,
): Effect.Effect<Check> => {
	if (stacks.length === 0) {
		return Effect.succeed({
			name: 'fork seed manifest',
			ok: true,
			required: false,
			detail: 'no fork stacks — skipped',
		});
	}
	const drifted: Array<{ stack: string; expected: string; got: string }> = [];
	for (const s of stacks) {
		const recomputed = computeConfigHash({
			upstream: s.upstream,
			...(s.checkpoint !== undefined ? { checkpoint: s.checkpoint } : {}),
			seedAddresses: s.seedAddresses,
			seedObjects: s.seedObjects,
		});
		if (recomputed !== s.configHash) {
			drifted.push({ stack: s.stack, expected: recomputed, got: s.configHash });
		}
	}
	if (drifted.length === 0) {
		return Effect.succeed({
			name: 'fork seed manifest',
			ok: true,
			required: false,
			detail: `${stacks.length} fork stack${stacks.length === 1 ? '' : 's'} self-consistent`,
		});
	}
	return Effect.succeed({
		name: 'fork seed manifest',
		ok: false,
		required: false,
		detail:
			`${drifted.length} stack${drifted.length === 1 ? '' : 's'} have corrupt meta.json (configHash drift): ` +
			drifted.map((d) => `${d.stack} (expected ${d.expected}, got ${d.got})`).join('; '),
	});
};

// P4.14 — fork data dir size per active fork stack. Informational. A
// large data dir is expected (the writable layer carries full chain
// state for the fork's lifetime); we surface the size so operators can
// compare against the 1GB threshold that flips `--include-fork-data`
// off in `snapshot save`.
export const checkForkDataSizes = async (
	stacks: ReadonlyArray<ForkStackEntry>,
): Promise<Check> => {
	if (stacks.length === 0) {
		return {
			name: 'fork data dir size',
			ok: true,
			required: false,
			detail: 'no fork stacks — skipped',
		};
	}
	const rows: Array<string> = [];
	for (const s of stacks) {
		const bytes = await safeDirSize(s.dataDir);
		rows.push(`${s.stack}=${formatBytes(bytes)}`);
	}
	return {
		name: 'fork data dir size',
		ok: true,
		required: false,
		detail: rows.join(', '),
	};
};
