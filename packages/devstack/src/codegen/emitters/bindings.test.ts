// BindingsEmitter — covers the three load-bearing behaviors:
//   1. Atomic dir swap (staging → final, with the pre-existing tree
//      replaced; partial writes never leak into the consumer's dir).
//   2. Fingerprint short-circuit (a second emit with identical inputs
//      skips `sui move summary` AND skips the dir swap, so Vite's
//      watcher doesn't fire HMR).
//   3. The skip path for KnownPackage entries (no `sourcePath`).
//
// We mock `sui move summary` via a no-op spawner and `generateFromPackageSummary`
// via vitest's `vi.mock` so the test runs in milliseconds without invoking
// the real Sui CLI or any heavyweight codegen.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { CodegenContext } from '../define-emitter.js';

// Mock the codegen package so we don't need a real `sui move summary`
// output tree. The mock writes a deterministic `<staging>/<packageName>/index.ts`
// — the bindings emitter probes that exact path post-codegen to verify
// the run produced output, so this satisfies the "write something" contract
// without invoking the real generator.
vi.mock('@mysten/codegen', () => ({
	generateFromPackageSummary: vi.fn(async ({ outputDir, package: pkg }: { outputDir: string; package: { packageName: string } }) => {
		const fs = await import('node:fs/promises');
		await fs.mkdir(joinPath(outputDir, pkg.packageName), { recursive: true });
		await fs.writeFile(
			joinPath(outputDir, pkg.packageName, 'index.ts'),
			`// mocked codegen output for ${pkg.packageName}\nexport const generated = true;\n`,
			'utf-8',
		);
	}),
}));

// Import AFTER the mock so the bindings emitter resolves to the stubbed
// `generateFromPackageSummary`.
const { BindingsEmitter } = await import('./bindings.js');

// Spawner stub — `sui move summary` becomes a no-op that exits 0. The
// bindings emitter only reads the exitCode; the actual summary file is
// produced by the mocked `generateFromPackageSummary` above.
const makeStubSpawner = (calls: Array<ReadonlyArray<string>>): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
	const spawn = (command: ChildProcess.Command) => {
		if (command._tag !== 'StandardCommand') {
			return Effect.die(new Error('bindings.test: unexpected piped command'));
		}
		calls.push([command.command, ...command.args]);
		return Effect.succeed(
			ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(1234),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain as never,
				stdout: Stream.empty,
				stderr: Stream.empty,
				all: Stream.empty,
				getInputFd: () => Sink.drain as never,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			}),
		);
	};
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn));
};

// Seed a minimal Move source tree under `sourcePath`. The fingerprint
// walk reads mtimes of `.move` / `Move.toml` / `Move.lock` files; a
// single .move file is enough.
const seedMoveSource = (root: string) => {
	mkdirSync(joinPath(root, 'sources'), { recursive: true });
	writeFileSync(joinPath(root, 'Move.toml'), '[package]\nname = "demo"\n');
	writeFileSync(joinPath(root, 'sources/demo.move'), 'module demo::demo {}');
};

describe('BindingsEmitter — happy path', () => {
	let outputDir: string;
	let sourceDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'bindings-out-'));
		sourceDir = mkdtempSync(joinPath(tmpdir(), 'bindings-src-'));
		seedMoveSource(sourceDir);
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
		rmSync(sourceDir, { recursive: true, force: true });
	});

	const ctx = (): CodegenContext => ({
		outputDir,
		packages: [
			{
				name: 'demo',
				packageId: '0xabc',
				mvrPlaceholder: '@local/demo',
				sourcePath: sourceDir,
			},
		],
	});

	it.effect('emits a bindings dir containing the codegen output for the local package', () =>
		Effect.gen(function* () {
			const spawnerCalls: Array<ReadonlyArray<string>> = [];
			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(makeStubSpawner(spawnerCalls)));

			// Final bindings dir landed under <outputDir>/bindings/<packageName>
			const expected = joinPath(outputDir, 'bindings', 'demo', 'index.ts');
			expect(existsSync(expected)).toBe(true);
			expect(readFileSync(expected, 'utf-8')).toContain('mocked codegen output for demo');

			// `sui move summary` ran exactly once.
			expect(spawnerCalls).toHaveLength(1);
			expect(spawnerCalls[0]![0]).toBe('sui');
			expect(spawnerCalls[0]!.slice(1)).toEqual(['move', 'summary']);
		}),
	);

	it.effect('staging dir is removed after a successful run', () =>
		Effect.gen(function* () {
			const spawnerCalls: Array<ReadonlyArray<string>> = [];
			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(makeStubSpawner(spawnerCalls)));

			// `bindings.ts` stages to `<outputDir>/bindings.staging-<rand>`
			// and renames to `<outputDir>/bindings`. After a clean run no
			// staging or discard sibling should remain.
			const siblings = require('node:fs').readdirSync(outputDir);
			const stagingOrDiscard = siblings.filter(
				(e: string) =>
					e.startsWith('bindings.staging-') || e.startsWith('bindings.discarding-'),
			);
			expect(stagingOrDiscard).toEqual([]);
			expect(siblings).toContain('bindings');
		}),
	);

	it.effect('atomic swap replaces a pre-existing bindings/ tree with the new contents', () =>
		Effect.gen(function* () {
			// Seed an "old" bindings dir with a stale file that the swap
			// must move aside. Without the atomic swap, the stale file
			// could survive alongside the new output and confuse the
			// consumer.
			mkdirSync(joinPath(outputDir, 'bindings'), { recursive: true });
			writeFileSync(
				joinPath(outputDir, 'bindings', 'stale.ts'),
				'// stale from a previous run',
				'utf-8',
			);
			const spawnerCalls: Array<ReadonlyArray<string>> = [];
			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(makeStubSpawner(spawnerCalls)));

			// The new mocked output is present.
			expect(existsSync(joinPath(outputDir, 'bindings', 'demo', 'index.ts'))).toBe(true);
			// The stale file is gone — atomic swap replaced the whole dir.
			expect(existsSync(joinPath(outputDir, 'bindings', 'stale.ts'))).toBe(false);
		}),
	);
});

describe('BindingsEmitter — fingerprint short-circuit', () => {
	let outputDir: string;
	let sourceDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'bindings-out-'));
		sourceDir = mkdtempSync(joinPath(tmpdir(), 'bindings-src-'));
		seedMoveSource(sourceDir);
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
		rmSync(sourceDir, { recursive: true, force: true });
	});

	const ctx = (): CodegenContext => ({
		outputDir,
		packages: [
			{
				name: 'demo',
				packageId: '0xabc',
				mvrPlaceholder: '@local/demo',
				sourcePath: sourceDir,
			},
		],
	});

	it.live('second emit with identical inputs skips spawn AND leaves bindings/ mtime untouched', () =>
		Effect.gen(function* () {
			const spawnerCalls: Array<ReadonlyArray<string>> = [];
			const spawnerLayer = makeStubSpawner(spawnerCalls);

			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(spawnerLayer));
			expect(spawnerCalls).toHaveLength(1);

			const bindingsDir = joinPath(outputDir, 'bindings');
			const beforeMtime = statSync(bindingsDir).mtimeMs;

			// Wait one tick so a swap-induced mtime bump would be measurable.
			yield* Effect.sleep('50 millis');

			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(spawnerLayer));

			// Fingerprint matched → no spawn, no swap.
			expect(spawnerCalls).toHaveLength(1);
			expect(statSync(bindingsDir).mtimeMs).toBe(beforeMtime);
		}),
	);

	it.effect('editing a .move file invalidates the fingerprint (re-spawns + re-swaps)', () =>
		Effect.gen(function* () {
			const spawnerCalls: Array<ReadonlyArray<string>> = [];
			const spawnerLayer = makeStubSpawner(spawnerCalls);

			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(spawnerLayer));
			expect(spawnerCalls).toHaveLength(1);

			// Touch a source file with a measurably-later mtime so the
			// fingerprint walk picks it up. Use `utimesSync` so we don't
			// depend on the underlying filesystem's mtime resolution.
			const fs = require('node:fs');
			const filePath = joinPath(sourceDir, 'sources/demo.move');
			const future = Date.now() / 1000 + 5;
			fs.utimesSync(filePath, future, future);

			yield* BindingsEmitter().emit(ctx()).pipe(Effect.provide(spawnerLayer));
			// Spawned again — fingerprint differs.
			expect(spawnerCalls).toHaveLength(2);
		}),
	);
});

describe('BindingsEmitter — package filtering', () => {
	let outputDir: string;
	let sourceDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'bindings-out-'));
		sourceDir = mkdtempSync(joinPath(tmpdir(), 'bindings-src-'));
		seedMoveSource(sourceDir);
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
		rmSync(sourceDir, { recursive: true, force: true });
	});

	it.effect('skips packages without a sourcePath (KnownPackage entries)', () =>
		Effect.gen(function* () {
			const spawnerCalls: Array<ReadonlyArray<string>> = [];
			yield* BindingsEmitter()
				.emit({
					outputDir,
					packages: [
						{ name: 'known', packageId: '0xfeed', mvrPlaceholder: '@known/x' },
					],
				})
				.pipe(Effect.provide(makeStubSpawner(spawnerCalls)));

			// No local targets → no spawn, no bindings dir.
			expect(spawnerCalls).toHaveLength(0);
			expect(existsSync(joinPath(outputDir, 'bindings'))).toBe(false);
		}),
	);

	it.effect("duplicate package names: first wins, duplicate is skipped (no HMR storm)", () =>
		Effect.gen(function* () {
			// Second tmpdir simulating a colliding `Package('demo', ...)` in
			// the user's config — load-bearing for the
			// "rename one of the packages" guidance the emitter logs.
			const otherSource = mkdtempSync(joinPath(tmpdir(), 'bindings-src-dup-'));
			seedMoveSource(otherSource);
			try {
				const spawnerCalls: Array<ReadonlyArray<string>> = [];
				yield* BindingsEmitter()
					.emit({
						outputDir,
						packages: [
							{
								name: 'demo',
								packageId: '0xa',
								mvrPlaceholder: '@local/demo',
								sourcePath: sourceDir,
							},
							{
								name: 'demo',
								packageId: '0xb',
								mvrPlaceholder: '@local/demo',
								sourcePath: otherSource,
							},
						],
					})
					.pipe(Effect.provide(makeStubSpawner(spawnerCalls)));

				// Only one spawn — the second 'demo' was skipped.
				expect(spawnerCalls).toHaveLength(1);
			} finally {
				rmSync(otherSource, { recursive: true, force: true });
			}
		}),
	);
});
