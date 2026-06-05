// Regression tests for the createdb argv-separator fix.
//
// Bug fix (review fix phase 22e/Bug 3): `ensureDatabase` previously
// invoked `['createdb', '-U', user, dbName]` with `dbName` placed in
// argv-positional form. The argv-array form already neutralized
// shell-metacharacter injection (the runtime hands argv straight to
// the exec syscall, no shell interpolation), but a `dbName` shaped
// like a flag (e.g. `--help`, `-h`, `--maintenance-db=x`) would still
// be parsed as a flag by `createdb` itself rather than as the
// positional database name. The fix prepends `--` to argv to halt
// flag parsing before the dbName slot.
//
// These tests pin the new contract by capturing the argv passed to
// `ContainerExec.run` and asserting the `--` separator is present
// immediately before the dbName argument.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerExec,
	ExecResult,
} from '../../../../src/plugins/internal/postgres-sidecar/db-ensure.ts';
import { ensureDatabase } from '../../../../src/plugins/internal/postgres-sidecar/db-ensure.ts';

const captureExec = (
	respond: (argv: ReadonlyArray<string>) => ExecResult,
): { readonly exec: ContainerExec; readonly calls: Array<ReadonlyArray<string>> } => {
	const calls: Array<ReadonlyArray<string>> = [];
	return {
		exec: {
			run: (argv) =>
				Effect.sync(() => {
					calls.push(argv);
					return respond(argv);
				}),
		},
		calls,
	};
};

describe('ensureDatabase — createdb argv flag-prefix neutralization', () => {
	it.effect('passes a `--` separator immediately before the dbName slot', () =>
		Effect.gen(function* () {
			const { exec, calls } = captureExec((argv) => {
				if (argv[0] === 'psql') {
					return { exitCode: 0, stdout: '', stderr: '' }; // not present
				}
				return { exitCode: 0, stdout: '', stderr: '' }; // createdb success
			});

			yield* ensureDatabase(exec, 'postgres', 'myapp');

			// Two calls: existence check (psql), then createdb.
			expect(calls.length).toBe(2);
			const createdbCall = calls[1]!;
			expect(createdbCall[0]).toBe('createdb');
			expect(createdbCall[1]).toBe('-U');
			expect(createdbCall[2]).toBe('postgres');
			expect(createdbCall[3]).toBe('--');
			expect(createdbCall[4]).toBe('myapp');
		}),
	);

	it.effect('routes a flag-shaped dbName through the `--` separator (no flag interpretation)', () =>
		Effect.gen(function* () {
			// `--help`-shaped names would be interpreted as a flag by
			// createdb prior to the separator fix. With the separator
			// in place, the name lands as a positional argument no
			// matter how flag-shaped it looks. We don't endorse such
			// names — the plugin contract still recommends lowercase
			// identifiers — but the argv shape is the security boundary
			// for callers that disregard the recommendation.
			const flagShaped = '--maintenance-db=evil';
			const { exec, calls } = captureExec(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			yield* ensureDatabase(exec, 'postgres', flagShaped);

			const createdbCall = calls[1]!;
			const dashDashIdx = createdbCall.indexOf('--');
			expect(dashDashIdx).toBeGreaterThanOrEqual(0);
			expect(createdbCall[dashDashIdx + 1]).toBe(flagShaped);
			// The dbName MUST appear after the separator, not before —
			// otherwise createdb's getopt would parse it as a flag.
			expect(createdbCall.indexOf(flagShaped)).toBe(dashDashIdx + 1);
		}),
	);

	it.effect('short-circuits when the database already exists (no createdb call at all)', () =>
		Effect.gen(function* () {
			// Sanity check the existing happy path still works: existence
			// check returns "1\n" => skip createdb entirely.
			const { exec, calls } = captureExec((argv) => {
				if (argv[0] === 'psql') {
					return { exitCode: 0, stdout: '1\n', stderr: '' };
				}
				throw new Error('createdb should not be invoked');
			});

			yield* ensureDatabase(exec, 'postgres', 'myapp');

			expect(calls.length).toBe(1);
			expect(calls[0]![0]).toBe('psql');
		}),
	);
});
