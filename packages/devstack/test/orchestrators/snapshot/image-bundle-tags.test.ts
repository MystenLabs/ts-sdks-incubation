import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	readImageBundleTags,
	verifyImageBundleTags,
} from '../../../src/orchestrators/snapshot/image-bundle-tags.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';
import { dockerSaveBundleTarWithLateMetadata } from './image-bundle-fixtures.ts';

describe('snapshot image bundle tag scanner', () => {
	it.effect('scans Docker save metadata after leading layer blobs', () =>
		withTempRoot('snapshot-image-bundle-test', (root) =>
			Effect.gen(function* () {
				const tag = 'devstack-snapshot:late-metadata';
				const tarPath = join(root, 'images.tar');
				writeFileSync(tarPath, dockerSaveBundleTarWithLateMetadata([tag]));

				const tags = yield* readImageBundleTags(tarPath, 'containers/images.tar');
				yield* verifyImageBundleTags('containers/images.tar', tags, [tag]);

				expect([...tags]).toEqual([tag]);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);
});
