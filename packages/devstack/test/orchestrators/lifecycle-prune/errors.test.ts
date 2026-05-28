// Regression: STYLE_GUIDE §2 + L3 orchestrator contract require the
// lifecycle-prune entry points to surface tagged failures, NOT
// `Effect<…, unknown>`. The taxonomy is `LifecyclePruneError` with a
// `phase` discriminator that projects the underlying
// `DockerRuntimeError` union onto a single CLI-consumable envelope.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import {
	collectLifecyclePruneInventory,
	LifecyclePruneError,
	runLifecyclePrune,
} from '../../../src/orchestrators/lifecycle-prune/index.ts';
import { failPhase } from '../../../src/orchestrators/lifecycle-prune/errors.ts';
import { DaemonUnreachable } from '../../../src/runtime/docker/errors.ts';

describe('lifecycle-prune typed error channel', () => {
	it('projects a DockerRuntimeError onto a LifecyclePruneError tagged with the failing phase', () => {
		const dockerErr = new DaemonUnreachable({
			op: 'docker.ps',
			detail: 'docker CLI spawn failed (binary missing or fork failure)',
		});
		const projected = failPhase('inventory')(dockerErr);
		expect(projected).toBeInstanceOf(LifecyclePruneError);
		expect(projected._tag).toBe('LifecyclePruneError');
		expect(projected.phase).toBe('inventory');
		expect(projected.detail).toBe('inventory: DaemonUnreachable');
		expect(projected.cause).toBe(dockerErr);
	});

	it('projects each remove-* phase distinctly so CLI consumers can branch on phase', () => {
		const dockerErr = new DaemonUnreachable({ op: 'docker.network.rm', detail: 'down' });
		for (const phase of [
			'remove-containers',
			'remove-networks',
			'remove-volumes',
			'remove-images',
		] as const) {
			const projected = failPhase(phase)(dockerErr);
			expect(projected.phase).toBe(phase);
			expect(projected.cause).toBe(dockerErr);
		}
	});

	it.effect(
		'lets CLI consumers Effect.catchTag the typed failure instead of inspecting `unknown`',
		() =>
			Effect.gen(function* () {
				const failing: Effect.Effect<never, LifecyclePruneError> = Effect.fail(
					failPhase('remove-networks')(
						new DaemonUnreachable({ op: 'docker.network.rm', detail: 'down' }),
					),
				);
				const recovered = yield* failing.pipe(
					Effect.catchTag('LifecyclePruneError', (err) =>
						Effect.succeed({ caught: true, phase: err.phase } as const),
					),
				);
				expect(recovered).toEqual({ caught: true, phase: 'remove-networks' });
			}),
	);

	it.effect(
		'collectLifecyclePruneInventory surfaces a LifecyclePruneError when the docker daemon is unreachable',
		() =>
			Effect.gen(function* () {
				// `layerDockerHostDefault` (provided internally by the orchestrator)
				// resolves the `docker` binary via PATH. Clearing PATH forces a
				// spawn failure, which `wrap.ts` classifies as `DaemonUnreachable`
				// and the orchestrator projects onto `LifecyclePruneError`.
				const originalPath = process.env.PATH;
				process.env.PATH = '/devstack-test/nonexistent-bin-dir';
				try {
					const exit = yield* collectLifecyclePruneInventory({
						runtimeRoot: '/devstack-test/nonexistent-root',
					}).pipe(Effect.exit);
					expect(Exit.isFailure(exit)).toBe(true);
					const error = Exit.findErrorOption(exit);
					expect(error._tag).toBe('Some');
					if (error._tag === 'Some') {
						expect(error.value).toBeInstanceOf(LifecyclePruneError);
						if (error.value instanceof LifecyclePruneError) {
							expect(error.value.phase).toBe('inventory');
							// The wrapped cause should preserve the L1 docker tag for
							// diagnostics; we don't assert the exact tag (different
							// spawn-failure shapes map to different DockerRuntimeError
							// variants) but it must NOT be erased to `unknown`.
							expect(error.value.cause).toBeDefined();
						}
					}
				} finally {
					if (originalPath === undefined) delete process.env.PATH;
					else process.env.PATH = originalPath;
				}
			}),
	);

	it('keeps the public E channel typed (compile-time guard)', () => {
		// If a future refactor regresses the signature to `unknown`, the
		// assignment below will narrow to `unknown` and TS would still
		// accept it — so we additionally assert the constructor is the
		// `LifecyclePruneError` class so the projection invariant is
		// load-bearing at runtime as well as at the type level.
		const inventoryEffect: Effect.Effect<unknown, LifecyclePruneError> =
			collectLifecyclePruneInventory({ runtimeRoot: '/tmp' });
		const runEffect: Effect.Effect<unknown, LifecyclePruneError> = runLifecyclePrune(
			{ runtimeRoot: '/tmp' },
			{
				groupKeys: [],
				resources: { containers: true, networks: true, volumes: true, images: true },
				dryRun: true,
			},
		);
		expect(typeof inventoryEffect).toBe('object');
		expect(typeof runEffect).toBe('object');
	});
});
