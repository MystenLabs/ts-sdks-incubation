import { describe, expect, it } from 'vitest';

import { composeDiscriminatorMaterial } from '../../../src/plugins/action/discriminator.ts';

describe('action discriminator material', () => {
	it('includes static dependency resource ids in declaration order', () => {
		expect(
			composeDiscriminatorMaterial(
				{
					actionName: 'seed-market',
					dependencyResourceIds: ['account/alice', 'package:vault'],
				},
				'roundtrip',
			),
		).toBe(
			[
				'action=seed-market',
				'dependencies=["account/alice","package:vault"]',
				'discriminator=roundtrip',
			].join('\n'),
		);
	});

	it('changes when dependencies change or reorder', () => {
		const base = composeDiscriminatorMaterial(
			{ actionName: 'seed-market', dependencyResourceIds: ['account/alice', 'package:vault'] },
			undefined,
		);
		const changed = composeDiscriminatorMaterial(
			{ actionName: 'seed-market', dependencyResourceIds: ['account/bob', 'package:vault'] },
			undefined,
		);
		const reordered = composeDiscriminatorMaterial(
			{ actionName: 'seed-market', dependencyResourceIds: ['package:vault', 'account/alice'] },
			undefined,
		);

		expect(changed).not.toBe(base);
		expect(reordered).not.toBe(base);
	});

	it('keeps the empty dependency list explicit', () => {
		expect(
			composeDiscriminatorMaterial(
				{ actionName: 'standalone', dependencyResourceIds: [] },
				undefined,
			),
		).toBe(['action=standalone', 'dependencies=[]'].join('\n'));
	});
});
