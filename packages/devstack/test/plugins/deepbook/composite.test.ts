// Unit tests for the deepbook composite plugin key.

import { describe, expect, it } from 'vitest';

import { deepbookPluginKey } from '../../../src/plugins/deepbook/composite.ts';

describe('deepbookPluginKey', () => {
	it('folds the instance name into a `deepbook:<name>` key', () => {
		expect(String(deepbookPluginKey('main'))).toBe('deepbook:main');
		expect(String(deepbookPluginKey('arena'))).toBe('deepbook:arena');
	});
});
