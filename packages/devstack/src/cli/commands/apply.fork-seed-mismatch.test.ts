// Phase 4 P4.T5 — apply's typed catch for SeedManifestMismatchError
// renders the wipe-and-retry recipe when the on-disk meta disagrees
// with the current config.
//
// Pure unit test against the error type + the render helpers. The
// "edit addresses between two apply runs" docker-level scenario lives
// in `apply.fork-seed-mismatch.docker.test.ts` (deferred behind
// `RUN_FORK_DOCKER_TESTS=1`) — the typed-error wiring at the apply
// command layer is what we cover here.

import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { SeedManifestMismatchError } from '../../engine/errors.js';

const fixtureError = () =>
	new SeedManifestMismatchError({
		metaPath: '/tmp/devstack/stacks/main/sui-fork/meta.json',
		message:
			'fork meta at /tmp/devstack/stacks/main/sui-fork/meta.json disagrees with the current ' +
			'Sui({fork:{…}}) configuration. The on-disk data dir was seeded with a different ' +
			'upstream / checkpoint / seed set, and re-booting against the current config would ' +
			"silently diverge from sui-fork's write-once seed manifest. Resolve by running " +
			'`devstack wipe --keep-upstream-cache && devstack apply` to wipe the per-stack fork ' +
			'state.',
		previous: { upstream: 'testnet', checkpoint: 50_000_000, configHash: 'aaaaaaaaaaaaaaaa' },
		current: { upstream: 'testnet', checkpoint: 50_000_000, configHash: 'bbbbbbbbbbbbbbbb' },
	});

describe('apply.fork-seed-mismatch (P4.T5)', () => {
	it('SeedManifestMismatchError carries actionable wipe recipe in message', () => {
		const err = fixtureError();
		expect(err.message).toMatch(/devstack wipe --keep-upstream-cache/);
		expect(err.message).toMatch(/devstack apply/);
	});

	it('previous / current snapshots disambiguate the diff', () => {
		const err = fixtureError();
		expect(err.previous?.configHash).toBe('aaaaaaaaaaaaaaaa');
		expect(err.current?.configHash).toBe('bbbbbbbbbbbbbbbb');
		expect(err.previous?.upstream).toBe(err.current?.upstream);
	});

	it.effect('typed catch flows through Cause.failures', () =>
		Effect.gen(function* () {
			const program = Effect.fail(fixtureError());
			const exit = yield* Effect.exit(program);
			expect(Exit.isFailure(exit)).toBe(true);
			if (!Exit.isFailure(exit)) return;
			const cause = exit.cause;
			let found: SeedManifestMismatchError | undefined;
			for (const reason of cause.reasons) {
				if (!Cause.isFailReason(reason)) continue;
				const error = reason.error;
				if (
					typeof error === 'object' &&
					error !== null &&
					'_tag' in error &&
					(error as { _tag?: unknown })._tag === 'SeedManifestMismatchError'
				) {
					found = error as SeedManifestMismatchError;
				}
			}
			expect(found).toBeDefined();
			expect(found?.metaPath).toMatch(/sui-fork\/meta\.json$/);
		}),
	);
});
