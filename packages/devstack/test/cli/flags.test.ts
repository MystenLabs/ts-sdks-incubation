import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { dispatch, type CliDeps, type GlobalFlags } from '../../src/surfaces/cli/index.ts';
import type { CliIO } from '../../src/surfaces/cli/output.ts';

const makeHarness = () => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	let exitCode: number | null = null;
	const upRuns: Array<GlobalFlags> = [];
	const io: CliIO = {
		writeStdout: (line) => Effect.sync(() => void stdout.push(line)),
		writeStderr: (line) => Effect.sync(() => void stderr.push(line)),
		setExitCode: (code) =>
			Effect.sync(() => {
				exitCode = code;
			}),
	};
	const deps: CliDeps = {
		up: {
			run: (flags) =>
				Effect.sync(() => {
					upRuns.push(flags);
					return { exitCode: 0 };
				}),
		},
		apply: { run: () => Effect.succeed({ exitCode: 0 }) },
		status: { reader: { readState: () => Effect.succeed(null) } },
		snapshot: {
			reader: {
				list: () => Effect.succeed([]),
				resolve: () => Effect.succeed({ tag: 'not-found' }),
			},
			capture: () => Effect.succeed({ snapshotId: 'snap-test', name: 'manual-test' }),
			restore: () => Effect.void,
			delete: () => Effect.void,
			confirm: () => Effect.succeed(true),
		},
		prune: {
			inventory: () =>
				Effect.succeed({
					groups: [],
					totals: {
						groups: 0,
						liveGroups: 0,
						sharedGroups: 0,
						containers: 0,
						runningContainers: 0,
						networks: 0,
						volumes: 0,
						images: 0,
					},
				}),
			prune: () =>
				Effect.succeed({
					kind: 'completed' as const,
					summary: {
						inspectedGroups: 0,
						selectedGroups: 0,
						skippedLiveGroups: 0,
						containersRemoved: 0,
						networksRemoved: 0,
						networksSkipped: 0,
						volumesRemoved: 0,
						imagesRemoved: 0,
					},
				}),
			select: (_inventory, resources) => Effect.succeed({ groupKeys: [], resources }),
		},
		doctor: { probes: [] },
		config: {
			loader: {
				load: () =>
					Effect.succeed({
						stack: { _tag: 'Stack' },
						resolvedConfigPath: '/tmp/devstack.config.ts',
					} as never),
			},
		},
		wipe: { wipe: () => Effect.void, confirm: () => Effect.succeed(true) },
	};
	return { deps, io, stdout, stderr, exitCode: () => exitCode, upRuns };
};

const run = async (
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>> = {},
) => {
	const h = makeHarness();
	await Effect.runPromise(dispatch(h.deps, { argv, env, stdinIsTty: true, io: h.io }));
	return h;
};

describe('cli command-scoped flags', () => {
	it('normalizes valid network flags through the Stricli dispatcher', async () => {
		const h = await run(['up', '--network', 'sui:testnet']);
		expect(h.exitCode()).toBe(0);
		expect(h.upRuns[0]!.network).toBe('testnet');
	});

	it('rejects unknown --network values', async () => {
		const h = await run(['up', '--network', 'bogus', '--json']);
		expect(h.exitCode()).toBe(64);
		const envelope = JSON.parse(h.stdout[0]!);
		expect(envelope.error.code).toBe('USAGE');
		expect(envelope.error.summary).toContain('--network must be one of');
		expect(h.upRuns).toHaveLength(0);
	});

	it('rejects unknown DEVSTACK_NETWORK values', async () => {
		const h = await run(['up', '--json'], { DEVSTACK_NETWORK: 'bogus' });
		expect(h.exitCode()).toBe(64);
		const envelope = JSON.parse(h.stdout[0]!);
		expect(envelope.error.code).toBe('USAGE');
		expect(envelope.error.summary).toContain('DEVSTACK_NETWORK must be one of');
		expect(h.upRuns).toHaveLength(0);
	});

	it('lets an explicit --network override an invalid DEVSTACK_NETWORK env value', async () => {
		const h = await run(['up', '--network', 'devnet'], { DEVSTACK_NETWORK: 'bogus' });
		expect(h.exitCode()).toBe(0);
		expect(h.upRuns[0]!.network).toBe('devnet');
	});
});
