// Unit tests for the deepbook plugin key.

import { describe, expect, it } from 'vitest';

import { deepbookPluginKey } from '../../../src/plugins/deepbook/plugin-key.ts';

describe('deepbookPluginKey', () => {
	it('folds the instance name into a `deepbook:<name>` key', () => {
		expect(String(deepbookPluginKey('main'))).toBe('deepbook:main');
		expect(String(deepbookPluginKey('arena'))).toBe('deepbook:arena');
	});
});
