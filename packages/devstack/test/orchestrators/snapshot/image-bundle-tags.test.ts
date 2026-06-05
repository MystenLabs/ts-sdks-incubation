import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { ImageBundleTagScanError } from '../../../src/orchestrators/snapshot/image-bundle-tags.ts';
import {
	readImageBundleTags,
	verifyImageBundleTags,
} from '../../../src/orchestrators/snapshot/image-bundle-tags.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';
import {
	dockerSaveBundleTar,
	dockerSaveBundleTarWithLateMetadata,
	tarEntry,
	tarPaxPathOverrideEntry,
} from './image-bundle-fixtures.ts';

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

	// Shared-reader coverage (Stage D3): the same tar reader serves the
	// host-tree validator AND this Docker-bundle scanner, so the
	// PAX-record path-override + malicious-linkpath defenses must be
	// exercised from this entrypoint too.
	it.effect('resolves a PAX-overridden manifest.json path through the shared reader', () =>
		withTempRoot('snapshot-image-bundle-test', (root) =>
			Effect.gen(function* () {
				const tag = 'devstack-snapshot:pax-manifest';
				const tarPath = join(root, 'images.tar');
				// The ustar name is a placeholder; the preceding PAX `x`
				// record overrides it with the real `manifest.json` path. A
				// reader that ignored PAX would skip this entry and report
				// "no manifest.json or index.json".
				const manifest = Buffer.from(
					JSON.stringify([{ Config: 'config.json', RepoTags: [tag], Layers: [] }]),
				);
				writeFileSync(
					tarPath,
					Buffer.concat([
						tarPaxPathOverrideEntry('manifest.json', 'placeholder.bin', manifest),
						Buffer.alloc(1024),
					]),
				);

				const tags = yield* readImageBundleTags(tarPath, 'containers/images.tar');
				expect([...tags]).toEqual([tag]);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it.effect('rejects a malicious symlink link target before reaching manifest.json', () =>
		withTempRoot('snapshot-image-bundle-test', (root) =>
			Effect.gen(function* () {
				const tag = 'devstack-snapshot:after-symlink';
				const tarPath = join(root, 'images.tar');
				// A symlink entry (typeflag '2') whose target escapes via
				// `..` precedes the manifest. The consolidated reader exposes
				// `isSafeArchivePath` on link targets, so the scan must fail
				// loud rather than silently read past it.
				writeFileSync(
					tarPath,
					Buffer.concat([
						tarEntry('evil-link', Buffer.alloc(0), { typeflag: '2', linkPath: '../../etc/passwd' }),
						dockerSaveBundleTar([tag]),
					]),
				);

				const exit = yield* Effect.exit(readImageBundleTags(tarPath, 'containers/images.tar'));
				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(ImageBundleTagScanError);
					expect(error.value.detail).toContain('unsafe tar link target');
					expect(error.value.detail).toContain('../../etc/passwd');
				}
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);
});
