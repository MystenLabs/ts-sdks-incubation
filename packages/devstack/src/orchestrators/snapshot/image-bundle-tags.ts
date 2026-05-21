import { Effect, FileSystem, Schema, Stream } from 'effect';

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

const TAR_BLOCK_SIZE = 512;
const MAX_DOCKER_SAVE_MANIFEST_BYTES = 1024 * 1024;

const bytesToString = (bytes: Uint8Array): string => {
	const nul = bytes.indexOf(0);
	const end = nul === -1 ? bytes.length : nul;
	return Buffer.from(bytes.subarray(0, end)).toString('utf8');
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
};

const consumeBytes = (buffer: Uint8Array, count: number): Uint8Array => buffer.subarray(count);

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

const parseTarSize = (header: Uint8Array): number | null => {
	const raw = bytesToString(header.subarray(124, 136)).trim();
	if (raw === '') return 0;
	if (!/^[0-7]+$/.test(raw)) return null;
	const parsed = Number.parseInt(raw, 8);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const tarPathFromHeader = (header: Uint8Array): string => {
	const name = bytesToString(header.subarray(0, 100));
	const prefix = bytesToString(header.subarray(345, 500));
	return prefix === '' ? name : `${prefix}/${name}`;
};

const normalizedTarEntryPath = (path: string): string => {
	let normalized = path;
	while (normalized.startsWith('./')) normalized = normalized.slice(2);
	return normalized;
};

type ImageBundleMetadataEntry = 'manifest.json' | 'index.json';

interface DockerSaveMetadataTarState {
	buffer: Uint8Array;
	skipRemaining: number;
	manifestBytes: Uint8Array | null;
	indexBytes: Uint8Array | null;
	content: {
		readonly entry: ImageBundleMetadataEntry;
		readonly size: number;
		readonly paddedSize: number;
		readonly chunks: Array<Uint8Array>;
		readonly contentBytesRead: number;
		readonly totalBytesRead: number;
	} | null;
}

const processDockerSaveMetadataChunk = (
	state: DockerSaveMetadataTarState,
	chunk: Uint8Array,
): { readonly done: boolean; readonly error?: ImageBundleTagScanError } => {
	state.buffer = concatBytes(state.buffer, chunk);
	while (state.buffer.length > 0) {
		if (state.content !== null) {
			const content = state.content;
			const remaining = content.paddedSize - content.totalBytesRead;
			const take = Math.min(remaining, state.buffer.length);
			const contentTake = Math.max(0, Math.min(take, content.size - content.contentBytesRead));
			if (contentTake > 0) {
				content.chunks.push(state.buffer.subarray(0, contentTake));
			}
			state.content = {
				...content,
				contentBytesRead: content.contentBytesRead + contentTake,
				totalBytesRead: content.totalBytesRead + take,
			};
			state.buffer = consumeBytes(state.buffer, take);
			if (state.content.totalBytesRead === state.content.paddedSize) {
				const completed = state.content;
				state.content = null;
				const entryBytes =
					completed.chunks.length === 1
						? completed.chunks[0]!
						: Buffer.concat(completed.chunks.map((entry) => Buffer.from(entry)));
				if (completed.entry === 'manifest.json') {
					state.manifestBytes = entryBytes;
					return { done: true };
				}
				state.indexBytes = entryBytes;
			}
			continue;
		}
		if (state.skipRemaining > 0) {
			const take = Math.min(state.skipRemaining, state.buffer.length);
			state.skipRemaining -= take;
			state.buffer = consumeBytes(state.buffer, take);
			continue;
		}
		if (state.buffer.length < TAR_BLOCK_SIZE) return { done: false };
		const header = state.buffer.subarray(0, TAR_BLOCK_SIZE);
		state.buffer = consumeBytes(state.buffer, TAR_BLOCK_SIZE);
		if (isZeroBlock(header)) continue;
		const size = parseTarSize(header);
		if (size === null) {
			return { done: false, error: failScan('docker save bundle has invalid tar size') };
		}
		const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
		const entryPath = normalizedTarEntryPath(tarPathFromHeader(header));
		if (entryPath === 'manifest.json' || entryPath === 'index.json') {
			if (size > MAX_DOCKER_SAVE_MANIFEST_BYTES) {
				return {
					done: false,
					error: failScan(`docker save ${entryPath} is too large`),
				};
			}
			if (size === 0) {
				if (entryPath === 'manifest.json') {
					state.manifestBytes = new Uint8Array(0);
					return { done: true };
				}
				state.indexBytes = new Uint8Array(0);
				continue;
			}
			state.content = {
				entry: entryPath,
				size,
				paddedSize,
				chunks: [],
				contentBytesRead: 0,
				totalBytesRead: 0,
			};
			continue;
		}
		state.skipRemaining = paddedSize;
	}
	return { done: false };
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
		const state: DockerSaveMetadataTarState = {
			buffer: new Uint8Array(0),
			skipRemaining: 0,
			manifestBytes: null,
			indexBytes: null,
			content: null,
		};
		yield* fs.stream(fullTarPath).pipe(
			Stream.takeUntilEffect((chunk) => {
				const result = processDockerSaveMetadataChunk(state, chunk);
				if (result.error !== undefined) return Effect.fail(result.error);
				return Effect.succeed(result.done);
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
