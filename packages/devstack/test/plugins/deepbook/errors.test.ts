// Unit tests for deepbook's error vocabulary + the fork-refusal
// shape (defense-in-depth — the primary refusal is type-level via
// the mode-narrowed factory).

import { describe, expect, it } from 'vitest';

import {
	DEEPBOOK_ERROR_TAGS,
	deepbookConfigError,
	deepbookPluginError,
	forkIncompatibleError,
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

describe('forkIncompatibleError', () => {
	it('refuses local deploy on fork networks', () => {
		const err = forkIncompatibleError('sui:mainnet-fork');
		expect(err._tag).toBe('ForkIncompatibleError');
		expect(err.variant).toBe('deepbookLocal');
		expect(err.network).toBe('sui:mainnet-fork');
	});

	it('includes an actionable hint pointing at the known branch', () => {
		const err = forkIncompatibleError('sui:testnet-fork');
		expect(err.hint).toMatch(/known/i);
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
