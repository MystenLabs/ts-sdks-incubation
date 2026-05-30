// CLI `wipe` verb — `--dry-run` enumerates the concrete deletion targets.
//
// Pre-fix `wipe --dry-run` emitted only "[dry-run] would wipe selected
// stack state" with no detail. Post-fix it calls the read-only
// `plan()` dep and lists the containers / network+volume label scope /
// state file / on-disk targets, both in the human lines and the
// `--json` envelope's `data.targets`. When no `plan` dep is wired it
// degrades to the generic line (and never calls the destructive
// `wipe()`).

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	runWipe,
	type WipeDeps,
	type WipeTargets,
} from '../../../../src/surfaces/cli/commands/wipe.ts';
import type { CommandContext } from '../../../../src/surfaces/cli/commands/index.ts';
import type { CliIO } from '../../../../src/surfaces/cli/output.ts';
import type { OutputMode } from '../../../../src/surfaces/cli/flags.ts';

const TARGETS: WipeTargets = {
	app: 'arena',
	stack: 'main',
	containers: ['devstack-arena-main-db', 'devstack-arena-main-svc'],
	networkLabelMatch: { app: 'arena', stack: 'main' },
	volumeLabelMatch: { app: 'arena', stack: 'main' },
	stateFile: '/root/stacks/main/state.json',
	stackRoot: '/root/stacks/main',
	onDiskPaths: ['/root/stacks/main/runtime', '/root/stacks/main/state.json'],
	preserved: ['snapshots'],
};

interface Harness {
	readonly io: CliIO;
	readonly stdout: ReadonlyArray<string>;
	readonly exit: () => number | null;
}

const makeHarness = (): Harness => {
	const stdout: Array<string> = [];
	let exitCode: number | null = null;
	const io: CliIO = {
		writeStdout: (line) => Effect.sync(() => void stdout.push(line)),
		writeStderr: () => Effect.void,
		setExitCode: (code) => Effect.sync(() => void (exitCode = code)),
	};
	return { io, stdout, exit: () => exitCode };
};

const ctxFor = (io: CliIO, mode: OutputMode): CommandContext => ({
	io,
	flags: {
		outputMode: mode,
		app: undefined,
		stack: undefined,
		stateDir: undefined,
		configPath: undefined,
		network: undefined,
		renderer: undefined,
		dryRun: true,
		// `--yes` so the destructive-confirm gate is satisfied without a
		// prompt — irrelevant on dry-run (confirm is skipped) but keeps the
		// fixture honest for both branches.
		confirm: { assumeYes: true, forbidPrompt: false, stdinIsTty: false },
		verbose: false,
		rest: [],
	},
});

describe('runWipe --dry-run enumeration', () => {
	it.effect('human mode lists containers, label scope, state file, and on-disk targets', () =>
		Effect.gen(function* () {
			const h = makeHarness();
			let wipeCalls = 0;
			const deps: WipeDeps = {
				wipe: () => Effect.sync(() => void (wipeCalls += 1)),
				plan: () => Effect.succeed(TARGETS),
				confirm: () => Effect.succeed(true),
			};
			yield* runWipe(deps, ctxFor(h.io, 'human'));

			const body = h.stdout.join('\n');
			expect(body).toContain('[dry-run] would wipe arena/main:');
			expect(body).toContain('devstack-arena-main-svc');
			expect(body).toContain('devstack-arena-main-db');
			expect(body).toContain('devstack.app=arena,devstack.stack=main');
			expect(body).toContain('/root/stacks/main/state.json');
			expect(body).toContain('/root/stacks/main/runtime');
			expect(body).toContain('preserved: snapshots');
			// Dry-run never calls the destructive wipe.
			expect(wipeCalls).toBe(0);
		}),
	);

	it.effect('json mode carries the enumerated targets in data.targets', () =>
		Effect.gen(function* () {
			const h = makeHarness();
			const deps: WipeDeps = {
				wipe: () => Effect.void,
				plan: () => Effect.succeed(TARGETS),
				confirm: () => Effect.succeed(true),
			};
			yield* runWipe(deps, ctxFor(h.io, 'json'));

			expect(h.stdout).toHaveLength(1);
			const env = JSON.parse(h.stdout[0]!) as {
				readonly dryRun: boolean;
				readonly data: { readonly dryRun: boolean; readonly targets?: WipeTargets };
			};
			expect(env.dryRun).toBe(true);
			expect(env.data.targets).toBeDefined();
			expect(env.data.targets!.containers).toEqual([
				'devstack-arena-main-db',
				'devstack-arena-main-svc',
			]);
			expect(env.data.targets!.onDiskPaths).toEqual([
				'/root/stacks/main/runtime',
				'/root/stacks/main/state.json',
			]);
			expect(env.data.targets!.preserved).toEqual(['snapshots']);
		}),
	);

	it.effect('falls back to the generic line when no plan dep is wired', () =>
		Effect.gen(function* () {
			const h = makeHarness();
			let wipeCalls = 0;
			const deps: WipeDeps = {
				wipe: () => Effect.sync(() => void (wipeCalls += 1)),
				// no `plan`
				confirm: () => Effect.succeed(true),
			};
			yield* runWipe(deps, ctxFor(h.io, 'human'));
			expect(h.stdout.join('\n')).toContain('[dry-run] would wipe selected stack state');
			expect(wipeCalls).toBe(0);
		}),
	);

	it.effect('degrades to the generic line when the plan probe fails (non-fatal)', () =>
		Effect.gen(function* () {
			const h = makeHarness();
			const deps: WipeDeps = {
				wipe: () => Effect.void,
				plan: () => Effect.fail(new Error('daemon unreachable')),
				confirm: () => Effect.succeed(true),
			};
			const result = yield* runWipe(deps, ctxFor(h.io, 'human'));
			// The command still SUCCEEDS (a dry-run preview must not hard-fail
			// on an enumeration hiccup) and emits the generic preview.
			expect(result.exitCode).toBe(0);
			expect(h.stdout.join('\n')).toContain('[dry-run] would wipe selected stack state');
		}),
	);
});
