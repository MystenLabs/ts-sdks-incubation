// Pure parser test for the `docker load` stdout line shape.
//
// Covers the substrate-side discipline: `loadImage` MUST recognise every
// tagged ("Loaded image: foo:bar") and digest-only ("Loaded image ID:
// sha256:...") line Docker reports for a bundle.

import { describe, expect, it } from 'vitest';

import { parseLoadedRefs } from '../../../src/runtime/docker/image.ts';

describe('parseLoadedRefs', () => {
	it('extracts a tagged image', () => {
		const parsed = parseLoadedRefs('Loaded image: my-image:latest\n');
		expect(parsed).toEqual([{ tag: 'my-image:latest' }]);
	});

	it('extracts a digest-only image', () => {
		const parsed = parseLoadedRefs('Loaded image ID: sha256:abc1234567890abcdef\n');
		expect(parsed).toEqual([
			{
				digest: 'sha256:abc1234567890abcdef',
			},
		]);
	});

	it('extracts every loaded image line in order', () => {
		const parsed = parseLoadedRefs(
			'Loaded image: my-image:1.0\nLoaded image ID: sha256:abc\nLoaded image: other:2.0\n',
		);
		expect(parsed).toEqual([
			{ tag: 'my-image:1.0' },
			{ digest: 'sha256:abc' },
			{ tag: 'other:2.0' },
		]);
	});

	it('returns an empty array on empty output', () => {
		expect(parseLoadedRefs('')).toEqual([]);
	});

	it('returns an empty array on garbage', () => {
		expect(parseLoadedRefs('something unrelated')).toEqual([]);
	});

	it('tolerates Windows line endings', () => {
		const parsed = parseLoadedRefs('Loaded image: foo:bar\r\n');
		expect(parsed[0]?.tag).toBe('foo:bar');
	});
});
