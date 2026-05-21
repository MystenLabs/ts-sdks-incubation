// Unit tests for the deepbook CompositePrimitive contribution.

import { describe, expect, it } from 'vitest';

import {
	deepbookPluginKey,
	makeDeepbookComposite,
} from '../../../src/plugins/deepbook/composite.ts';
import { defaultDeepbookSourceSiblingKey } from '../../../src/plugins/deepbook/lifted-siblings/source-fetch.ts';

describe('deepbookPluginKey', () => {
	it('folds the instance name into a `deepbook:<name>` key', () => {
		expect(String(deepbookPluginKey('main'))).toBe('deepbook:main');
		expect(String(deepbookPluginKey('arena'))).toBe('deepbook:arena');
	});
});

describe('makeDeepbookComposite', () => {
	it('emits a composite-primitive decl with the per-instance key', () => {
		const decl = makeDeepbookComposite({
			name: 'main',
			liftedSiblings: [],
			innerParticipants: [],
		});
		expect(decl.kind).toBe('composite-primitive');
		expect(String(decl.compositeKey)).toBe('deepbook:main');
	});

	it('threads lifted siblings + inner participants through unchanged', () => {
		const sibling = defaultDeepbookSourceSiblingKey();
		const decl = makeDeepbookComposite({
			name: 'main',
			liftedSiblings: [sibling],
			innerParticipants: [],
		});
		expect(decl.liftedSiblings).toEqual([sibling]);
		expect(decl.innerParticipants).toEqual([]);
	});
});
