import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	readImageBundleTags,
	verifyImageBundleTags,
} from '../../../src/orchestrators/snapshot/image-bundle-tags.ts';
import { dockerSaveBundleTarWithLateMetadata } from './image-bundle-fixtures.ts';

const freshRoot = (): string => mkdtempSync(join(tmpdir(), 'snapshot-image-bundle-test-'));

describe('snapshot image bundle tag scanner', () => {
	it.effect('scans Docker save metadata after leading layer blobs', () =>
		Effect.gen(function* () {
			const root = freshRoot();
			try {
				const tag = 'devstack-snapshot:late-metadata';
				const tarPath = join(root, 'images.tar');
				writeFileSync(tarPath, dockerSaveBundleTarWithLateMetadata([tag]));

				const tags = yield* readImageBundleTags(tarPath, 'containers/images.tar');
				yield* verifyImageBundleTags('containers/images.tar', tags, [tag]);

				expect([...tags]).toEqual([tag]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
