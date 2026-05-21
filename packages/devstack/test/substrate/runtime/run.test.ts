import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import { defineNodePlugin } from '../../../src/api/define-plugin.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import type { SupervisedStack } from '../../../src/substrate/runtime/supervisor.ts';
import { defineTag } from '../../../src/substrate/tag.ts';
import { runStackEffect } from '../../../src/substrate/runtime/run.ts';

const identity: Identity = {
	app: appName('run-test-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

describe('substrate/runtime/run', () => {
	it.effect('one-shot supervision fails when initial acquire fails', () =>
		Effect.gen(function* () {
			const tagFail = defineTag<'test:one-shot-fail', { readonly ok: true }>(
				'test:one-shot-fail',
				'fail',
			);
			const pluginFail = defineNodePlugin({
				provides: tagFail,
				consumes: [] as const,
				kind: 'leaf-long-running' as const,
				acquire: () =>
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
					runtimeRoot: mkdtempSync(join(tmpdir(), 'devstack-run-one-shot-')),
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
	);
});
