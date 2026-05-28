import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import type { SupervisedStack } from '../../src/substrate/runtime/supervisor/index.ts';
import { definePlugin } from '../../src/substrate/plugin.ts';
import { runStackEffect } from '../../src/orchestrators/run.ts';
import { withTempRoot } from '../helpers/with-temp-root.ts';

const identity: Identity = {
	app: appName('run-test-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

describe('orchestrators/run', () => {
	it.effect('one-shot supervision fails when initial start fails', () =>
		withTempRoot('devstack-run-one-shot', (runtimeRoot) =>
			Effect.gen(function* () {
				const pluginFail = definePlugin({
					id: 'test:one-shot-fail',
					role: 'service' as const,
					section: 'service',
					start: () =>
						Effect.fail(new Error('initial acquire failed')) as Effect.Effect<
							{ readonly ok: true },
							Error,
							never
						>,
				});
				const stack: SupervisedStack = {
					_tag: 'Stack',
					members: [pluginFail],
					options: {},
				};

				const exit = yield* Effect.exit(
					runStackEffect(stack, identity, {
						lifetime: 'one-shot',
						runtimeRoot,
					}),
				);

				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const error = Exit.findErrorOption(exit);
					expect(error._tag).toBe('Some');
					if (error._tag === 'Some') {
						expect(error.value._tag).toBe('PluginAcquireFailed');
						if (error.value._tag === 'PluginAcquireFailed') {
							expect(error.value.pluginKey).toBe('test:one-shot-fail#0');
							expect(error.value.cause).toBeInstanceOf(Error);
							if (error.value.cause instanceof Error) {
								expect(error.value.cause.message).toBe('initial acquire failed');
							}
						}
					}
				}
			}),
		),
	);
});
