import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	SnapshotLayout,
	containerImagesBundlePath,
} from '../../../src/orchestrators/snapshot/index.ts';

export const tarEntry = (entryPath: string, content: Uint8Array): Buffer => {
	const header = Buffer.alloc(512);
	header.write(entryPath, 0, 'utf8');
	header.write('0000644\0', 100, 'ascii');
	header.write('0000000\0', 108, 'ascii');
	header.write('0000000\0', 116, 'ascii');
	header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
	header.write('00000000000\0', 136, 'ascii');
	header[156] = '0'.charCodeAt(0);
	const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
	return Buffer.concat([header, Buffer.from(content), padding]);
};

export const dockerSaveBundleTar = (repoTags: ReadonlyArray<string>): Buffer =>
	Buffer.concat([
		tarEntry(
			'manifest.json',
			Buffer.from(
				JSON.stringify([
					{
						Config: 'config.json',
						RepoTags: repoTags,
						Layers: [],
					},
				]),
			),
		),
		Buffer.alloc(1024),
	]);

export const dockerSaveBundleTarWithLateMetadata = (repoTags: ReadonlyArray<string>): Buffer =>
	Buffer.concat([
		tarEntry(`blobs/sha256/${'a'.repeat(64)}`, Buffer.alloc(80 * 1024, 7)),
		dockerSaveBundleTar(repoTags),
	]);

export const dockerOciImageLayoutBundleTar = (repoTags: ReadonlyArray<string>): Buffer =>
	Buffer.concat([
		tarEntry(
			'./index.json',
			Buffer.from(
				JSON.stringify({
					schemaVersion: 2,
					mediaType: 'application/vnd.oci.image.index.v1+json',
					manifests: repoTags.map((tag, index) => ({
						mediaType: 'application/vnd.oci.image.manifest.v1+json',
						digest: `sha256:${String(index + 1).repeat(64)}`,
						size: 401,
						annotations: {
							'io.containerd.image.name': `docker.io/library/${tag}`,
							'org.opencontainers.image.ref.name': tag.slice(tag.indexOf(':') + 1),
						},
					})),
				}),
			),
		),
		tarEntry('./oci-layout', Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }))),
		Buffer.alloc(1024),
	]);

export const writeImageBundle = (
	artifactDir: string,
	repoTags: ReadonlyArray<string> = ['devstack-snapshot:postgres-db'],
	opts: { readonly format?: 'docker-legacy' | 'oci-layout' } = {},
) => {
	mkdirSync(join(artifactDir, SnapshotLayout.containersDir), { recursive: true });
	writeFileSync(
		join(artifactDir, containerImagesBundlePath()),
		opts.format === 'oci-layout'
			? dockerOciImageLayoutBundleTar(repoTags)
			: dockerSaveBundleTar(repoTags),
	);
};
