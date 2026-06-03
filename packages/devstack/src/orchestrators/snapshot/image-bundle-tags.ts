import { Effect, FileSystem, Schema, Stream } from 'effect';

import {
	captureEntry,
	isSafeArchivePath,
	makeTarReaderState,
	processTarChunk,
	skipEntry,
	stopScan,
	type TarEntry,
	type TarEntryDirective,
} from '../../substrate/runtime/tar/reader.ts';
import { isRestorableContainerImageName } from './descriptor.ts';

export class ImageBundleTagScanError extends Schema.TaggedErrorClass<ImageBundleTagScanError>()(
	'SnapshotImageBundleTagScanError',
	{
		detail: Schema.String,
		cause: Schema.optional(Schema.Defect),
	},
) {}

const failScan = (detail: string, cause?: unknown): ImageBundleTagScanError =>
	new ImageBundleTagScanError({
		detail,
		...(cause === undefined ? {} : { cause }),
	});

const MAX_DOCKER_SAVE_MANIFEST_BYTES = 1024 * 1024;

const normalizedTarEntryPath = (path: string): string => {
	let normalized = path;
	while (normalized.startsWith('./')) normalized = normalized.slice(2);
	return normalized;
};

// Metadata-only scan state. The shared tar reader owns the block
// discipline + pax/gnu handling; this state just collects the two
// metadata entries we care about and a `done` flag so the stream drain
// can short-circuit once manifest.json lands.
interface DockerSaveMetadataState {
	manifestBytes: Uint8Array | null;
	indexBytes: Uint8Array | null;
	done: boolean;
}

// Per-entry directive for the Docker-save / OCI-layout metadata scan.
// Docker `save` bundles are a TRUSTED-extraction path: this scanner only
// reads manifest.json / index.json metadata and never writes any file to
// disk, so it does NOT untar bodies. `isSafeArchivePath` is applied for
// defense-in-depth (a malicious linkpath / escaping entry path is
// rejected) without tightening acceptance of valid OCI bundles — only
// the manifest/index entries are captured; all other members (layer
// blobs, configs) are skipped as before.
const onMetadataEntry = (
	state: DockerSaveMetadataState,
	entry: TarEntry,
): TarEntryDirective | ImageBundleTagScanError => {
	if (!isSafeArchivePath(entry.path)) {
		return failScan(`docker save bundle has unsafe tar entry path: ${entry.path}`);
	}
	if ((entry.typeflag === '1' || entry.typeflag === '2') && !isSafeArchivePath(entry.linkPath)) {
		return failScan(`docker save bundle has unsafe tar link target: ${entry.linkPath}`);
	}
	const entryPath = normalizedTarEntryPath(entry.path);
	if (entryPath === 'manifest.json' || entryPath === 'index.json') {
		if (entry.size > MAX_DOCKER_SAVE_MANIFEST_BYTES) {
			return failScan(`docker save ${entryPath} is too large`);
		}
		if (entry.size === 0) {
			if (entryPath === 'manifest.json') {
				state.manifestBytes = new Uint8Array(0);
				state.done = true;
				return stopScan();
			}
			state.indexBytes = new Uint8Array(0);
			return skipEntry();
		}
		return captureEntry();
	}
	return skipEntry();
};

const onMetadataContent = (
	state: DockerSaveMetadataState,
	entry: TarEntry,
	body: Uint8Array,
): null => {
	const entryPath = normalizedTarEntryPath(entry.path);
	if (entryPath === 'manifest.json') {
		state.manifestBytes = body;
		state.done = true;
	} else {
		state.indexBytes = body;
	}
	return null;
};

const parseDockerSaveManifestTags = (
	bytes: Uint8Array,
	tarPath: string,
): Effect.Effect<ReadonlySet<string>, ImageBundleTagScanError> =>
	Effect.gen(function* () {
		const raw = yield* Effect.try({
			try: () => JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
			catch: (cause) =>
				failScan(`docker save manifest.json in ${tarPath} is not valid JSON`, cause),
		});
		if (!Array.isArray(raw)) {
			return yield* Effect.fail(
				failScan(`docker save manifest.json in ${tarPath} is not an array`),
			);
		}
		const tags = new Set<string>();
		for (const [index, entry] of raw.entries()) {
			if (typeof entry !== 'object' || entry === null) {
				return yield* Effect.fail(
					failScan(`docker save manifest entry ${index} in ${tarPath} is not an object`),
				);
			}
			const repoTags = (entry as { readonly RepoTags?: unknown }).RepoTags;
			if (repoTags === undefined || repoTags === null) continue;
			if (!Array.isArray(repoTags)) {
				return yield* Effect.fail(
					failScan(`docker save manifest entry ${index} in ${tarPath} has non-array RepoTags`),
				);
			}
			for (const tag of repoTags) {
				if (typeof tag !== 'string' || !isRestorableContainerImageName(tag)) {
					return yield* Effect.fail(
						failScan(
							`docker save manifest entry ${index} in ${tarPath} has invalid RepoTag ${String(
								tag,
							)}`,
						),
					);
				}
				if (tags.has(tag)) {
					return yield* Effect.fail(
						failScan(`docker save manifest in ${tarPath} repeats RepoTag ${tag}`),
					);
				}
				tags.add(tag);
			}
		}
		return tags;
	});

const normalizeOciImageName = (value: string): string | null => {
	const dockerLibraryPrefix = 'docker.io/library/';
	if (value.startsWith(dockerLibraryPrefix)) {
		const localName = value.slice(dockerLibraryPrefix.length);
		if (localName.startsWith('devstack-snapshot:') && isRestorableContainerImageName(localName)) {
			return localName;
		}
		return null;
	}
	if (value.startsWith('devstack-snapshot:') && isRestorableContainerImageName(value)) {
		return value;
	}
	return null;
};

const parseOciImageLayoutIndexTags = (
	bytes: Uint8Array,
	tarPath: string,
): Effect.Effect<ReadonlySet<string>, ImageBundleTagScanError> =>
	Effect.gen(function* () {
		const raw = yield* Effect.try({
			try: () => JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
			catch: (cause) => failScan(`docker save index.json in ${tarPath} is not valid JSON`, cause),
		});
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			return yield* Effect.fail(failScan(`docker save index.json in ${tarPath} is not an object`));
		}
		const manifests = (raw as { readonly manifests?: unknown }).manifests;
		if (!Array.isArray(manifests)) {
			return yield* Effect.fail(
				failScan(`docker save index.json in ${tarPath} has non-array manifests`),
			);
		}
		const tags = new Set<string>();
		for (const [index, entry] of manifests.entries()) {
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
				return yield* Effect.fail(
					failScan(`docker save index manifest ${index} in ${tarPath} is not an object`),
				);
			}
			const annotations = (entry as { readonly annotations?: unknown }).annotations;
			if (annotations === undefined || annotations === null) continue;
			if (typeof annotations !== 'object' || Array.isArray(annotations)) {
				return yield* Effect.fail(
					failScan(`docker save index manifest ${index} in ${tarPath} has invalid annotations`),
				);
			}
			const imageName = (annotations as { readonly ['io.containerd.image.name']?: unknown })[
				'io.containerd.image.name'
			];
			const refName = (annotations as { readonly ['org.opencontainers.image.ref.name']?: unknown })[
				'org.opencontainers.image.ref.name'
			];
			for (const value of [imageName, refName]) {
				if (typeof value !== 'string') continue;
				const tag = normalizeOciImageName(value);
				if (tag === null) continue;
				if (tags.has(tag)) {
					return yield* Effect.fail(
						failScan(`docker save index in ${tarPath} repeats RepoTag ${tag}`),
					);
				}
				tags.add(tag);
			}
		}
		return tags;
	});

export const readImageBundleTags = (
	fullTarPath: string,
	tarPath: string,
): Effect.Effect<ReadonlySet<string>, ImageBundleTagScanError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const state: DockerSaveMetadataState = {
			manifestBytes: null,
			indexBytes: null,
			done: false,
		};
		const reader = makeTarReaderState();
		yield* fs.stream(fullTarPath).pipe(
			Stream.takeUntilEffect((chunk) => {
				const error = processTarChunk(reader, chunk, {
					onEntry: (entry) => onMetadataEntry(state, entry),
					onContent: (entry, body) => onMetadataContent(state, entry, body),
					onExtendedError: (detail) => failScan(`docker save bundle ${detail}`),
				});
				if (error !== null) return Effect.fail(error);
				return Effect.succeed(state.done);
			}),
			Stream.runDrain,
			Effect.catch((cause) =>
				cause instanceof ImageBundleTagScanError
					? Effect.fail(cause)
					: Effect.fail(failScan(`read docker save metadata from ${fullTarPath} failed`, cause)),
			),
		);
		if (state.manifestBytes !== null) {
			return yield* parseDockerSaveManifestTags(state.manifestBytes, tarPath);
		}
		if (state.indexBytes !== null) {
			return yield* parseOciImageLayoutIndexTags(state.indexBytes, tarPath);
		}
		return yield* Effect.fail(
			failScan(`docker save bundle ${tarPath} does not contain manifest.json or index.json`),
		);
	});

export const verifyImageBundleTags = (
	tarPath: string,
	actualTags: ReadonlySet<string>,
	expectedSnapshotTags: ReadonlyArray<string>,
): Effect.Effect<void, ImageBundleTagScanError> => {
	const expected = new Set<string>();
	const repeatedExpected: string[] = [];
	for (const tag of expectedSnapshotTags) {
		if (expected.has(tag)) {
			repeatedExpected.push(tag);
		} else {
			expected.add(tag);
		}
	}
	if (repeatedExpected.length > 0) {
		return Effect.fail(
			failScan(
				`docker save bundle ${tarPath} expected duplicate snapshot tags: ${repeatedExpected.join(
					', ',
				)}`,
			),
		);
	}
	const missing = [...expected].filter((tag) => !actualTags.has(tag));
	const unexpected = [...actualTags].filter((tag) => !expected.has(tag));
	if (missing.length === 0 && unexpected.length === 0) return Effect.void;
	const parts: string[] = [];
	if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
	if (unexpected.length > 0) parts.push(`unexpected: ${unexpected.join(', ')}`);
	return Effect.fail(
		failScan(
			`docker save bundle ${tarPath} tags do not match snapshot metadata (${parts.join('; ')})`,
		),
	);
};
