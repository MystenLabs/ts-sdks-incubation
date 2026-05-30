// Unit tests for deepbook's error vocabulary.

import { describe, expect, it } from 'vitest';

import {
	DEEPBOOK_ERROR_TAGS,
	deepbookConfigError,
	deepbookPluginError,
} from '../../../src/plugins/deepbook/errors.ts';

describe('deepbookPluginError', () => {
	it('returns a tagged structure ready for catchTag', () => {
		const err = deepbookPluginError('publish', 'boom');
		expect(err._tag).toBe('DeepbookPluginError');
		expect(err.phase).toBe('publish');
		expect(err.message).toBe('boom');
	});

	it('preserves optional capture envelopes', () => {
		const err = deepbookPluginError('indexer', 'crash', {
			stdout: 'out',
			stderr: 'err',
			exitCode: 137,
		});
		expect(err.stdout).toBe('out');
		expect(err.stderr).toBe('err');
		expect(err.exitCode).toBe(137);
	});
});

describe('deepbookConfigError', () => {
	it('carries the offending field name', () => {
		const err = deepbookConfigError('publisher', 'missing', 'pass a member');
		expect(err._tag).toBe('DeepbookConfigError');
		expect(err.field).toBe('publisher');
		expect(err.hint).toBe('pass a member');
	});
});

describe('DEEPBOOK_ERROR_TAGS', () => {
	it('lists every tag this plugin contributes for the cause walker', () => {
		expect(DEEPBOOK_ERROR_TAGS).toEqual([
			'DeepbookPluginError',
			'ForkIncompatibleError',
			'DeepbookConfigError',
		]);
	});
});
