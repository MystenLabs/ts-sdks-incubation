// Host-environment binary checks: `docker version`, `sui --version`.
//
// Docker is required (the inventory + every stack op depends on a
// reachable daemon). Sui is informational — devstack ships its own
// build container, but ad-hoc `sui` calls in user scripts still need
// a host binary, and we warn on minor-version drift between the host
// binary and the pinned build container so a "schema diverged" failure
// has a leading-edge signal.

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import type { Check } from './_check.js';

type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

export const checkDocker = (spawner: Spawner): Effect.Effect<Check> =>
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

// Match the pinned `DEFAULT_SUI_VERSION` from `services/sui.ts` so
// doctor's drift hint stays in sync without importing the engine
// (the CLI is a thin entrypoint; pulling in the engine here would
// drag in the whole supervisor surface).
const PINNED_SUI_VERSION_TAG = 'devnet-v1.71.0';

// Parse the major.minor.patch out of either form of `sui --version`
// output (`sui 1.71.0-abcdef` or `sui 1.71.0`). Returns undefined when
// the string doesn't match — drift detection silently skips in that
// case rather than printing a misleading warning.
const parseSuiSemver = (text: string): string | undefined => {
	const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
	if (match === null) return undefined;
	return `${match[1]}.${match[2]}.${match[3]}`;
};

const compareMinor = (a: string, b: string): number => {
	const [aM, am] = a.split('.').map(Number) as [number, number, number];
	const [bM, bm] = b.split('.').map(Number) as [number, number, number];
	if (aM !== bM) return aM - bM;
	return am - bm;
};

export const checkSui = (spawner: Spawner): Effect.Effect<Check> =>
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
		// Drift check: parse the host sui's semver and compare against the
		// pinned build-container tag. A patch difference is fine; a minor
		// or major difference is a warning so users see the mismatch
		// before they hit a "schema diverged" failure in `sui move build`
		// or `sui move summary` against vendored Move sources.
		const hostSemver = parseSuiSemver(out.text);
		const pinnedSemver = parseSuiSemver(PINNED_SUI_VERSION_TAG);
		if (hostSemver !== undefined && pinnedSemver !== undefined) {
			const drift = Math.abs(compareMinor(hostSemver, pinnedSemver));
			if (drift > 0) {
				return {
					name: 'Sui CLI',
					ok: true,
					required: false,
					detail: `${out.text} (drift: build container pinned at ${PINNED_SUI_VERSION_TAG}; bindings codegen routes through it, but ad-hoc \`sui\` calls may diverge)`,
				};
			}
		}
		return { name: 'Sui CLI', ok: true, required: false, detail: out.text };
	});
