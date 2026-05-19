// Unit tests for the synchronous repo/ref validators inside `gitFetch`.
// The validators run at factory construction so disallowed values
// surface at config-load time (where the stack trace points at the
// user's `gitFetch({...})` call) rather than at acquire time deep
// inside an Effect chain. Calling `gitFetch(...)` with a malformed
// `repo` or `ref` must throw a typed `GitFetchError` so consumers can
// `catchTag('GitFetchError', ...)` from a top-level catch block.

import { describe, expect, it } from 'vitest';
import { GitFetchError, gitFetch } from './git-fetch.js';

describe('gitFetch validators', () => {
	it('throws GitFetchError for an empty repo', () => {
		expect(() => gitFetch({ name: 'x', repo: '', ref: 'main' })).toThrow(GitFetchError);
	});

	it('throws GitFetchError for a repo starting with - (flag-injection)', () => {
		expect(() => gitFetch({ name: 'x', repo: '--upload-pack=evil', ref: 'main' })).toThrow(
			GitFetchError,
		);
	});

	it('throws GitFetchError for a disallowed transport (file://)', () => {
		expect(() => gitFetch({ name: 'x', repo: 'file:///tmp/repo', ref: 'main' })).toThrow(
			GitFetchError,
		);
	});

	it('throws GitFetchError for an empty ref', () => {
		expect(() => gitFetch({ name: 'x', repo: 'https://example.com/r.git', ref: '' })).toThrow(
			GitFetchError,
		);
	});

	it('throws GitFetchError for a ref starting with -', () => {
		expect(() => gitFetch({ name: 'x', repo: 'https://example.com/r.git', ref: '--evil' })).toThrow(
			GitFetchError,
		);
	});

	it('throws GitFetchError for a ref with disallowed characters', () => {
		expect(() => gitFetch({ name: 'x', repo: 'https://example.com/r.git', ref: 'a b' })).toThrow(
			GitFetchError,
		);
	});

	it('throws GitFetchError for a ref containing the @@ typo', () => {
		expect(() => gitFetch({ name: 'x', repo: 'https://example.com/r.git', ref: 'a@@b' })).toThrow(
			GitFetchError,
		);
	});

	it('thrown values carry the GitFetchError _tag', () => {
		try {
			gitFetch({ name: 'x', repo: '', ref: 'main' });
			throw new Error('expected gitFetch to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(GitFetchError);
			const typed = err as GitFetchError;
			expect(typed._tag).toBe('GitFetchError');
			expect(typed.message).toMatch(/repo must not be empty/);
		}
	});

	it('accepts a well-formed https repo + ref without throwing', () => {
		// Validators are synchronous and don't actually clone — a well-formed
		// call should return a LayeredTag without going to the network.
		expect(() =>
			gitFetch({ name: 'x', repo: 'https://github.com/owner/repo.git', ref: 'v1.2.3' }),
		).not.toThrow();
	});

	it('accepts the SCP-style git@host:owner/repo.git shorthand', () => {
		expect(() =>
			gitFetch({ name: 'x', repo: 'git@github.com:owner/repo.git', ref: 'main' }),
		).not.toThrow();
	});
});
