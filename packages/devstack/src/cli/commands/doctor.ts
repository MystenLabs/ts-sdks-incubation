// `devstack doctor` — preflight checks + inventory.
//
// V3 parity port. Two-section report, none of which mutate state:
//
//   - Pre-flight checks: docker daemon, sui CLI, common host ports.
//   - Inventory: every (app, stack) bucket of devstack-labelled docker
//     resources on the machine, plus on-disk state dirs. The inventory
//     reads labels from `docker ps -a` / `docker network ls` /
//     `docker volume ls` filtered on `label=devstack.app`, and walks
//     `<cwd>/.devstack/` for state.
//
// We use a fixed port set (9000, 9123, 9125, 5180) per the v4 port plan —
// the v3 version walked the prior snapshot for allocated ports, but v4's
// state-store doesn't yet record per-snapshot port leases in a shape the
// CLI can read without booting the engine.
//
// Doesn't construct an engine. Safe to run any time. Exits 0 unless docker
// is unreachable.

import { Console, Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Command } from 'effect/unstable/cli';
import { createServer } from 'node:net';
import {
	collectInventory,
	renderInventoryRow,
	renderTotals,
	totalsFor,
} from '../../engine/docker/inventory.js';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly detail?: string;
}

const COMMON_PORTS: ReadonlyArray<number> = [9000, 9123, 9125, 5180];

const checkDocker = (spawner: Spawner): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('docker', ['version', '--format', '{{.Server.Version}}']);
		const out = yield* spawner.string(cmd).pipe(
			Effect.map((s) => ({ ok: true, text: s.trim() })),
			Effect.catch((err) => Effect.succeed({ ok: false, text: String(err) })),
		);
		if (!out.ok) {
			return {
				name: 'Docker daemon',
				ok: false,
				required: true,
				detail: out.text.includes('ENOENT')
					? 'docker not found on PATH'
					: `\`docker version\` failed: ${out.text}`,
			};
		}
		if (out.text.length === 0) {
			return { name: 'Docker daemon', ok: false, required: true, detail: 'no server version' };
		}
		return { name: 'Docker daemon', ok: true, required: true, detail: `server ${out.text}` };
	});

const checkSui = (spawner: Spawner): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const cmd = ChildProcess.make('sui', ['--version']);
		const out = yield* spawner.string(cmd).pipe(
			Effect.map((s) => ({ ok: true, text: s.trim() })),
			Effect.catch((err) => Effect.succeed({ ok: false, text: String(err) })),
		);
		if (!out.ok) {
			return {
				name: 'Sui CLI',
				ok: false,
				required: false,
				detail: out.text.includes('ENOENT')
					? 'sui not found on PATH — see https://docs.sui.io/guides/developer/getting-started/sui-install'
					: `\`sui --version\` failed: ${out.text}`,
			};
		}
		return { name: 'Sui CLI', ok: true, required: false, detail: out.text };
	});

// Try to bind 0.0.0.0:port. EADDRINUSE → bound; clean close → free. Note we
// use 0.0.0.0 to catch both v4 and v6 listeners (vs 127.0.0.1 which can
// race past a ::1 binding) — matches the prompt's spec.
const isPortBound = (port: number): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const server = createServer();
		server.unref();
		server.once('error', (err) => {
			const code = (err as { code?: string }).code;
			resume(Effect.succeed(code === 'EADDRINUSE'));
		});
		server.listen(port, '0.0.0.0', () => {
			server.close(() => resume(Effect.succeed(false)));
		});
	});

const checkPort = (port: number): Effect.Effect<Check> =>
	Effect.gen(function* () {
		const bound = yield* isPortBound(port);
		return {
			name: `port ${port}`,
			ok: true,
			required: false,
			detail: bound ? 'bound (in use)' : 'free',
		};
	});

const renderCheck = (c: Check): string => {
	const tag = c.ok ? '✓' : c.required ? '✗' : '!';
	const reqTag = c.required ? '' : ' (informational)';
	const detail = c.detail !== undefined ? ` — ${c.detail}` : '';
	return `  ${tag} ${c.name}${reqTag}${detail}`;
};

export const doctorCommand = Command.make('doctor', {}, () =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const docker = yield* checkDocker(spawner);
		const sui = yield* checkSui(spawner);
		const ports: Array<Check> = [];
		for (const p of COMMON_PORTS) {
			ports.push(yield* checkPort(p));
		}
		const all: Array<Check> = [docker, sui, ...ports];
		yield* Console.log('Checks');
		for (const c of all) {
			yield* Console.log(renderCheck(c));
		}

		// Inventory only runs when the docker daemon is reachable —
		// otherwise `collectInventory` would emit empty rows and the
		// section would be noise. Doctor's exit-code semantics are
		// unchanged: docker-down still fails the command.
		if (docker.ok) {
			yield* Console.log('');
			yield* Console.log('Inventory');
			const rows = yield* collectInventory();
			if (rows.length === 0) {
				yield* Console.log('  (no devstack-labelled resources)');
			} else {
				for (const row of rows) {
					yield* Console.log(renderInventoryRow(row));
				}
				yield* Console.log('');
				yield* Console.log(renderTotals(totalsFor(rows)));
				// Compact running / repo-gone summary line. Only mentions
				// repo-gone when there's at least one — otherwise the
				// hint below is the only call to action and the line
				// stays quiet.
				const runningCount = rows.filter((r) => r.runningPid !== undefined).length;
				const repoGoneCount = rows.filter((r) => r.classification === 'repo-gone').length;
				yield* Console.log(
					`Total: ${rows.length} stack${rows.length === 1 ? '' : 's'}. ${runningCount} running. ${repoGoneCount} with missing repo directory.`,
				);
				if (repoGoneCount > 0) {
					yield* Console.log('');
					yield* Console.log(
						`Run \`devstack prune --repo-gone --yes\` to clean ${repoGoneCount} stack${repoGoneCount === 1 ? '' : 's'} whose project is gone.`,
					);
				}
			}
		}

		const failedRequired = all.filter((c) => c.required && !c.ok);
		if (failedRequired.length > 0) {
			yield* Console.log('');
			yield* Console.log(`${failedRequired.length} required check(s) failed.`);
			return yield* Effect.fail(new Error('doctor: required checks failed'));
		}
	}),
).pipe(
	Command.withDescription('Preflight checks + inventory of devstack-labelled docker resources'),
);
