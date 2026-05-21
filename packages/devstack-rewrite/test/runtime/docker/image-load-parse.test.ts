// Pure parser test for the `docker load` stdout line shape.
//
// Covers the substrate-side discipline: `loadImage` MUST recognise both
// tagged ("Loaded image: foo:bar") and digest-only ("Loaded image ID:
// sha256:...") shapes — both are emitted by docker depending on
// whether the image carries a tag in its manifest.

import { describe, expect, it } from 'vitest';

import { parseLoadedRef } from '../../../src/runtime/docker/image.ts';

describe('parseLoadedRef', () => {
	it('extracts a tagged image', () => {
		const parsed = parseLoadedRef('Loaded image: my-image:latest\n');
		expect(parsed).toEqual({ tag: 'my-image:latest' });
	});

	it('extracts a digest-only image', () => {
		const parsed = parseLoadedRef('Loaded image ID: sha256:abc1234567890abcdef\n');
		expect(parsed).toEqual({
			digest: 'sha256:abc1234567890abcdef',
		});
	});

	it('prefers the tagged line when both appear', () => {
		const parsed = parseLoadedRef('Loaded image: my-image:1.0\nLoaded image ID: sha256:abc\n');
		// Tagged form takes priority — snapshot restore aliases via the
		// recorded tag and the digest is only the fallback identity.
		expect(parsed).toEqual({ tag: 'my-image:1.0' });
	});

	it('returns null on empty output', () => {
		expect(parseLoadedRef('')).toBeNull();
	});

	it('returns null on garbage', () => {
		expect(parseLoadedRef('something unrelated')).toBeNull();
	});

	it('tolerates Windows line endings', () => {
		const parsed = parseLoadedRef('Loaded image: foo:bar\r\n');
		expect(parsed?.tag).toBe('foo:bar');
	});
});
