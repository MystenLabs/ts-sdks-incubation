// Snapshot descriptor — validation tests.
//
// Pins the typed-error contract: `snapshotIdFromString` throws a
// `SnapshotDescriptorError` instance with `_tag` and `kind` so
// downstream classifiers can `catchTag` instead of sniffing the
// message. STYLE_GUIDE §2 rule 5.

import { describe, expect, it } from '@effect/vitest';

import {
	SnapshotDescriptorError,
	parseSnapshotId,
	snapshotIdFromString,
} from '../../../src/orchestrators/snapshot/descriptor.ts';

describe('snapshot descriptor', () => {
	it('parseSnapshotId returns null for invalid ids', () => {
		expect(parseSnapshotId('')).toBeNull();
		expect(parseSnapshotId('../escape')).toBeNull();
		expect(parseSnapshotId('with space')).toBeNull();
	});

	it('parseSnapshotId returns the branded value for valid ids', () => {
		expect(parseSnapshotId('snap-123')).toBe('snap-123');
		expect(parseSnapshotId('Abc_de.f'.replace('.', '_'))).toBe('Abc_de_f');
	});

	it('snapshotIdFromString throws a tagged SnapshotDescriptorError on invalid input', () => {
		let caught: unknown;
		try {
			snapshotIdFromString('with space');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SnapshotDescriptorError);
		if (caught instanceof SnapshotDescriptorError) {
			expect(caught._tag).toBe('SnapshotDescriptorError');
			expect(caught.kind).toBe('invalid-id');
			expect(caught.value).toBe('with space');
		}
	});
});
