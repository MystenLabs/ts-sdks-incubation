// The host summary runner's toolchain gate, exercised with the real Node
// spawner against a fake `sui` placed first on PATH — so the probe, the
// spawn-failure fallback and the fail/warn branches all run for real.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';

import {
	ensureHostCliHonoursPin,
	hostSuiVersion,
} from '../../../src/plugins/sui/move-summary-runner.ts';

const PKG = { packageName: 'hello', sourcePath: '/tmp/hello' };
const explicit = (suiToolsRef: string) =>
	({ kind: 'sui-tools', suiToolsRef, explicit: true }) as const;

// Same composition the codegen CLI wiring uses for its host runner.
const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

let binDir: string;

/** Put a fake `sui` first on PATH that prints `versionLine`; or, with
 *  `null`, an empty dir so `sui` cannot be found at all. */
const fakeSui = (versionLine: string | null) => {
	if (versionLine !== null) {
		const script = join(binDir, 'sui');
		writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${versionLine}'\n`);
		chmodSync(script, 0o755);
	}
	vi.stubEnv('PATH', binDir);
};

const gate = (toolchain: Parameters<typeof ensureHostCliHonoursPin>[1]) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		return yield* ensureHostCliHonoursPin(hostSuiVersion(spawner), toolchain, PKG);
	}).pipe(Effect.provide(spawnerLayer));

beforeEach(() => {
	binDir = mkdtempSync(join(tmpdir(), 'devstack-fake-sui-'));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(binDir, { recursive: true, force: true });
});

describe('ensureHostCliHonoursPin', () => {
	it.effect('probes the host CLI once when the probe is cached, however many packages run', () =>
		Effect.gen(function* () {
			let probes = 0;
			const probe = yield* Effect.cached(Effect.sync(() => ((probes += 1), 'sui 1.80.0-abc')));
			yield* ensureHostCliHonoursPin(probe, explicit('testnet-v1.80.0'), PKG);
			yield* ensureHostCliHonoursPin(probe, explicit('testnet-v1.80.0'), {
				...PKG,
				packageName: 'other',
			});
			expect(probes).toBe(1);
		}),
	);

	it.effect('never probes the host CLI when no explicit toolchain is pinned', () =>
		Effect.gen(function* () {
			fakeSui(null); // no `sui` anywhere on PATH: a probe would fail loudly
			yield* gate(undefined);
			yield* gate({ kind: 'sui-tools', suiToolsRef: 'bundled', explicit: false });
		}),
	);

	it.effect('accepts a host CLI whose release matches the pin', () =>
		Effect.gen(function* () {
			fakeSui('sui 1.80.0-abc123def456');
			yield* gate(explicit('testnet-v1.80.0'));
		}),
	);

	it.effect('fails with an actionable error on a verifiable release mismatch', () =>
		Effect.gen(function* () {
			fakeSui('sui 1.77.2-homebrew');
			const error = yield* gate(explicit('testnet-v1.80.0')).pipe(Effect.flip);
			expect(error._tag).toBe('CodegenBindingsFailed');
			expect(error.reason).toBe('summary-failed');
			expect(error.package).toBe('hello');
			expect(error.hint).toContain('1.77.2');
			expect(error.hint).toContain('testnet-v1.80.0');
			expect(error.hint).toContain('suiup install sui@testnet-v1.80.0');
			// The hint reaches the CLI through `message`, not just the field.
			expect(error.message).toContain('suiup install');
		}),
	);

	it.effect('treats a pin it cannot verify as a warning, not a failure', () =>
		Effect.gen(function* () {
			fakeSui('sui 1.80.0-892d777c');
			yield* gate(explicit('892d777ccdf414f13b9421641831fc57462a8c6e'));
		}),
	);

	it.effect('treats a failed version probe (no host sui) as unverifiable, not a failure', () =>
		Effect.gen(function* () {
			fakeSui(null);
			yield* gate(explicit('testnet-v1.80.0'));
		}),
	);
});
