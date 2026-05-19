// `stripPinnedSections` is the load-bearing pure function inside
// `scrubLockFileIfPresent` / `scrubMoveLock`. Both legacy `[env]` /
// `[env.<name>]` sections (v3 Move.lock format) AND v4-flat
// `[pinned.<env>.<pkg>]` sections embed a network-pinned package id
// that, if left in place, ends up baked into the bytecode at
// `sui move build` time — the publish then fails on a fresh localnet
// because the testnet/mainnet ids aren't on chain. This file pins the
// transform's behavior so regressions in the parser surface here
// instead of as opaque publish failures inside an example's
// `move build`.

import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Sink, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { buildMove, shellQuote, stripPinnedSections, SuiBuildImage } from './sui-cli.js';

describe('stripPinnedSections', () => {
	it('strips v4-flat [pinned.<env>.<pkg>] sections', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[pinned.testnet.token]',
			'source = { git = "..." }',
			'original-id = "0xabc"',
			'published-at = "0xdef"',
			'',
			'[pinned.testnet.deepbook]',
			'original-id = "0x123"',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[pinned.');
		expect(output).not.toContain('original-id');
		expect(output).not.toContain('published-at');
		// Non-stripped section preserved.
		expect(output).toContain('[move]');
		expect(output).toContain('version = 4');
	});

	it('strips legacy [env] and [env.<name>] sections', () => {
		const input = [
			'[move]',
			'version = 3',
			'',
			'[env]',
			'default = "testnet"',
			'',
			'[env.testnet]',
			'chain-id = "4c78adac"',
			'original-published-id = "0xabc"',
			'latest-published-id = "0xdef"',
			'published-version = "1"',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[env]');
		expect(output).not.toContain('[env.testnet]');
		expect(output).not.toContain('chain-id');
		expect(output).not.toContain('original-published-id');
		expect(output).toContain('[move]');
		expect(output).toContain('version = 3');
	});

	it('strips both pinned and env sections from a mixed file, preserves the rest verbatim', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[[move.toolchain-version]]',
			'compiler-version = "1.71.0"',
			'edition = "2024"',
			'',
			'[env.testnet]',
			'chain-id = "4c78adac"',
			'',
			'[pinned.testnet.token]',
			'original-id = "0xabc"',
			'',
			'[[move.dependencies]]',
			'name = "Sui"',
			'source = { local = "../sui-framework" }',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[env.');
		expect(output).not.toContain('[pinned.');
		expect(output).not.toContain('chain-id');
		expect(output).not.toContain('original-id');
		// Non-stripped sections preserved with their bodies.
		expect(output).toContain('[[move.toolchain-version]]');
		expect(output).toContain('compiler-version = "1.71.0"');
		expect(output).toContain('[[move.dependencies]]');
		expect(output).toContain('source = { local = "../sui-framework" }');
	});

	it('is idempotent: stripping a scrubbed file returns the same string', () => {
		const input = [
			'[move]',
			'version = 4',
			'',
			'[pinned.testnet.token]',
			'original-id = "0xabc"',
			'',
			'[env.testnet]',
			'chain-id = "4c78adac"',
		].join('\n');

		const once = stripPinnedSections(input);
		const twice = stripPinnedSections(once);
		expect(twice).toBe(once);
	});

	it('matches headers tolerantly of leading whitespace (tabs and spaces)', () => {
		// Move.lock files in the wild are normally flush-left, but the
		// parser uses `trimStart()` before matching so indented sections
		// also get stripped. Pin that behavior — a regression that
		// matched only `^[\[`-prefixed lines would silently leak
		// indented `[pinned.*]` sections through.
		const input = [
			'[move]',
			'version = 4',
			'',
			'\t[pinned.testnet.token]',
			'\toriginal-id = "0xabc"',
			'',
			'  [env.testnet]',
			'  chain-id = "4c78adac"',
			'',
			'[after]',
			'keep = true',
		].join('\n');

		const output = stripPinnedSections(input);
		expect(output).not.toContain('[pinned.');
		expect(output).not.toContain('[env.');
		expect(output).not.toContain('original-id');
		expect(output).not.toContain('chain-id');
		// The `[after]` section must survive — proves we don't keep
		// `skipping` set after the indented section ends.
		expect(output).toContain('[after]');
		expect(output).toContain('keep = true');
	});

	it('leaves a file without any pinned/env sections unchanged', () => {
		const input = ['[move]', 'version = 4', '', '[[move.dependencies]]', 'name = "Sui"'].join('\n');
		expect(stripPinnedSections(input)).toBe(input);
	});
});

// -----------------------------------------------------------------------------
// shellQuote
// -----------------------------------------------------------------------------
//
// `shellQuote` is the only defense between user-controlled package
// names / paths (which become `--path /workspace/<name>` and the docker
// image tag inside the container build pipeline) and the shell that
// interprets the outer `sh -c` script in `containerBuildCmd`. A bug
// here lets a publishMove caller with a malicious `name` or `path`
// inject arbitrary commands into the host shell.
//
// We pin the POSIX single-quote escape contract:
//   - Plain strings round-trip wrapped in `'…'`.
//   - Embedded single quotes are broken out via the standard `'\''`
//     four-char dance (close, escape, reopen).
//   - Other shell metacharacters ($, `, ", ;, &, |, *, ?, etc.) are
//     inert inside single quotes — the test asserts they are passed
//     through unmodified, NOT escaped.

describe('shellQuote', () => {
	it('wraps a plain string in single quotes', () => {
		expect(shellQuote('hello')).toBe(`'hello'`);
	});

	it('wraps a string containing spaces in single quotes (POSIX argv split-prevention)', () => {
		// Without the wrap, `sh -c` would tokenize on the space and the
		// container build would receive two args instead of one.
		expect(shellQuote('hello world')).toBe(`'hello world'`);
	});

	it('escapes a single embedded apostrophe via the close/escape/reopen trick', () => {
		// `it's` → `'it'\''s'`. The `'\''` is: close the open quote,
		// emit a literal `'` via backslash escape, then reopen.
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	it('escapes multiple apostrophes in a single string', () => {
		expect(shellQuote("a'b'c")).toBe(`'a'\\''b'\\''c'`);
	});

	it('passes shell metacharacters through verbatim inside the quote', () => {
		// $, `, ", ;, &, |, (, ), {, }, *, ?, [, ], \\ — none should
		// be expanded or interpreted by sh because they're inside
		// single quotes. A regression that switched to double-quote
		// wrapping would break this test (`$VAR` would expand).
		const dangerous = '$VAR `whoami` "x" ; rm -rf / & echo | true * ? \\';
		expect(shellQuote(dangerous)).toBe(`'${dangerous}'`);
	});

	it('blocks command injection via embedded apostrophe + shell construct', () => {
		// The classic attack: a malicious package name like
		// `foo'; rm -rf / #` would, without the apostrophe escape,
		// close the wrap and inject `rm -rf /` into the outer shell.
		// With the escape it becomes a literal — the resulting argv
		// inside the container is the verbatim string the caller
		// supplied, which `sui move build --path /workspace/<that>`
		// will fail on as a non-existent directory. Failure mode: bad
		// path, NOT command execution. We assert the exact escape
		// output so a regression that switched to a permissive shell-
		// quote (e.g. just doubling the quote) breaks here.
		const attack = "foo'; rm -rf / #";
		expect(shellQuote(attack)).toBe(`'foo'\\''; rm -rf / #'`);
	});

	it('handles an empty string as a present-but-empty argv slot', () => {
		// `sh -c "echo $(shellQuote '')"` should pass an empty arg, not
		// drop the slot. The wrap `''` is the POSIX way to say so.
		expect(shellQuote('')).toBe(`''`);
	});
});

// -----------------------------------------------------------------------------
// buildMove — cross-process move-build lock funnel
// -----------------------------------------------------------------------------
//
// `sui move build` mutates `~/.move/git/<repo>/.git/` (sparse-checkout.lock,
// index.lock). Two concurrent invocations against the same host race those
// per-repo git locks and fail with "Another git process seems to be running".
// The original landing of `withMoveBuildLock` wrapped only the
// SuiBuildContainer.runBuild branch — which left the `docker run --rm` and
// host-CLI fallbacks (the two other code paths inside `buildMove`)
// unsynchronized, so e.g. `seal.publish` + `vault` in the `private-content`
// example still raced when neither path went through SuiBuildContainer.
//
// The fix hoisted the lock to `buildMove` itself so all three paths share
// one host-wide O_EXCL lock keyed on `~/.move`. This test exercises that
// invariant: two concurrent `buildMove` calls must spawn their `sui move
// build` invocations one-at-a-time, NOT in parallel.

describe('buildMove — concurrent funnel serialization', () => {
	// `it.live` opts out of `it.effect`'s TestClock — both the fake
	// spawner's `Effect.sleep(BUILD_DELAY_MS)` AND the lock-acquire
	// retry loop's `Effect.sleep` would freeze under TestClock, so we
	// run against the real wall-clock here.
	it.live('two concurrent buildMove calls serialize their build spawns', () =>
		Effect.gen(function* () {
			interface SpawnTrace {
				readonly startedAtMs: number;
				readonly finishedAtMs: number;
				readonly args: ReadonlyArray<string>;
			}
			const traces: Array<SpawnTrace> = [];
			const BUILD_DELAY_MS = 50;

			// Fake docker spawner. Every spawn records its start
			// timestamp at the moment the spawner is invoked, then the
			// exitCode Effect sleeps for BUILD_DELAY_MS before logging
			// the finish timestamp. Two concurrent calls with no lock
			// would land their startedAtMs within a few ms of each
			// other; with the host-wide lock the second startedAtMs
			// must land at-or-after the first finishedAtMs.
			const spawn = (command: ChildProcess.Command) => {
				if (command._tag !== 'StandardCommand') {
					return Effect.die(new Error('unexpected non-standard command'));
				}
				const args = [...command.args];
				const startedAtMs = Date.now();
				const encoder = new TextEncoder();
				const stdoutJson = '{"modules":["AA=="],"dependencies":[]}\n';
				const handle = ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(9001),
					exitCode: Effect.sleep(`${BUILD_DELAY_MS} millis`).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								traces.push({ startedAtMs, finishedAtMs: Date.now(), args });
							}),
						),
						Effect.map(() => ChildProcessSpawner.ExitCode(0)),
					),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					stdin: Sink.drain as never,
					stdout: Stream.succeed(encoder.encode(stdoutJson)),
					stderr: Stream.empty,
					all: Stream.succeed(encoder.encode(stdoutJson)),
					getInputFd: () => Sink.drain as never,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
				return Effect.succeed(handle);
			};
			const spawnerLayer = Layer.succeed(
				ChildProcessSpawner.ChildProcessSpawner,
				ChildProcessSpawner.make(spawn),
			);

			// `SuiBuildImage` present so the host-CLI scrub branch is
			// skipped (would otherwise hit a real FS). No
			// SuiBuildContainer service provided — canExec is false and
			// buildMove routes to the fresh `docker run --rm` branch,
			// which used to be unlocked.
			const imageLayer = Layer.succeed(SuiBuildImage, { tag: 'devstack/sui:test' });
			const fsLayer = FileSystem.layerNoop({});

			yield* Effect.all(
				[
					buildMove({ path: '/tmp/pkg-a', rpcUrl: 'http://localhost:9000' }),
					buildMove({ path: '/tmp/pkg-b', rpcUrl: 'http://localhost:9000' }),
				],
				{ concurrency: 'unbounded' },
			).pipe(Effect.provide(spawnerLayer), Effect.provide(imageLayer), Effect.provide(fsLayer));

			expect(traces.length).toBe(2);
			const sorted = [...traces].sort((a, b) => a.startedAtMs - b.startedAtMs);
			const [first, second] = sorted;
			expect(second!.startedAtMs).toBeGreaterThanOrEqual(first!.finishedAtMs);
		}),
	);
});
