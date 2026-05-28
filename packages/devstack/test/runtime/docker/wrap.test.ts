// Stderr-classifier regression coverage.
//
// The `isMissingImage*` / `isMissingNetwork*` classifiers gate the
// idempotent remove paths and the sweep's silent-skip behaviour: a
// bare `/not found/` alternation misclassifies permission-denied or
// registry-auth errors as "missing", which would let sweep skip them.
// These tests pin the daemon's canonical wordings against the
// most-confusable misclassifications.

import { describe, expect, it } from 'vitest';

import {
	isMissingImageStderr,
	isMissingNetworkStderr,
	isNetworkInUseStderr,
} from '../../../src/runtime/docker/wrap.ts';

describe('isMissingImageStderr', () => {
	it('matches the canonical "No such image" daemon wording', () => {
		expect(isMissingImageStderr('Error response from daemon: No such image: foo:bar')).toBe(true);
	});

	it('matches "reference does not exist" alternation', () => {
		expect(
			isMissingImageStderr(
				'Error response from daemon: reference does not exist for foo/bar:latest',
			),
		).toBe(true);
	});

	it('does NOT misclassify pull-access-denied "repository does not exist" wording', () => {
		// This is the wording that the prior bare `/not found/` alternation
		// caught — pull access denied is a permission/auth error, NOT a
		// missing-image. Sweep would silently skip it.
		expect(
			isMissingImageStderr(
				"Error response from daemon: pull access denied for foo, repository does not exist or may require 'docker login'",
			),
		).toBe(false);
	});

	it('does NOT misclassify a generic "not found" permission-denied error', () => {
		// "permission denied: not found in dataset" is an FS/auth error,
		// not a docker-image-missing error. Prior bare `/not found/` would
		// have misclassified this as missing.
		expect(
			isMissingImageStderr('Error response from daemon: permission denied: not found in dataset'),
		).toBe(false);
	});
});

describe('isMissingNetworkStderr', () => {
	it('matches the canonical "No such network" daemon wording', () => {
		expect(isMissingNetworkStderr('Error response from daemon: No such network: foo')).toBe(true);
	});

	it('matches the canonical "network <name> not found" daemon wording', () => {
		expect(isMissingNetworkStderr('Error response from daemon: network foo not found')).toBe(true);
	});

	it('does NOT misclassify a generic permission-denied "not found" error', () => {
		expect(
			isMissingNetworkStderr('Error response from daemon: permission denied: not found in dataset'),
		).toBe(false);
	});
});

describe('isNetworkInUseStderr', () => {
	it('matches "has active endpoints"', () => {
		expect(
			isNetworkInUseStderr(
				'Error response from daemon: network foo has active endpoints (name:"bar" id:"abc")',
			),
		).toBe(true);
	});

	it('matches "is in use"', () => {
		expect(isNetworkInUseStderr('Error response from daemon: network foo is in use')).toBe(true);
	});
});
