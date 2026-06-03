// tar/reader — shared low-level TAR block reader.
//
// Two devstack surfaces parse TAR byte streams: the host-tree snapshot
// validator (`substrate/runtime/host-tree-tar`) and the Docker image
// bundle tag scanner (`orchestrators/snapshot/image-bundle-tags`). They
// used to carry byte-identical copies of the block iterator, header
// parse, pax/gnu extended-header handling, and the `isSafeArchivePath`
// path-escape guard. This module is the single source of truth for that
// machinery so a pax/gnu fix lands on both surfaces at once.
//
// Shape:
//   - `processTarChunk` is a stateful, streaming block iterator. The
//     caller feeds chunks; the reader resolves complete entries (after
//     applying any preceding pax `x` / gnu `L`/`K` extended-header that
//     overrides the path / linkpath) and invokes the caller's `onEntry`
//     hook. The hook returns a `TarEntryDirective` that tells the reader
//     whether to CAPTURE the entry body (returned via `onContent`), SKIP
//     it, or STOP the scan early.
//   - The reader owns pax/gnu parsing, body buffering, and the
//     512-byte block discipline; callers own their domain validation
//     and metadata extraction.
//
// Security note: `isSafeArchivePath` rejects absolute paths, `..`
// segments, backslashes, and NUL — applied to BOTH the entry path and
// (for hardlink/symlink typeflags) the link target. Symlink targets are
// NOT canonicalized here; relative targets are caught by `..` rejection,
// and native `tar -x` refuses escaping paths as a second layer.

export const TAR_BLOCK_SIZE = 512;

/** Max bytes a single pax/gnu extended-header record may declare. A
 *  larger declared size is rejected so a malicious archive cannot force
 *  unbounded in-memory buffering of an "extended path". */
export const MAX_TAR_EXTENDED_PATH_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Byte helpers — shared by both header parse and content buffering.
// ---------------------------------------------------------------------------

export const bytesToString = (bytes: Uint8Array): string => {
	const nul = bytes.indexOf(0);
	const end = nul === -1 ? bytes.length : nul;
	return Buffer.from(bytes.subarray(0, end)).toString('utf8');
};

export const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
};

export const consumeBytes = (buffer: Uint8Array, count: number): Uint8Array =>
	buffer.subarray(count);

export const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

export const parseTarSize = (header: Uint8Array): number | null => {
	const raw = bytesToString(header.subarray(124, 136)).trim();
	if (raw === '') return 0;
	if (!/^[0-7]+$/.test(raw)) return null;
	const parsed = Number.parseInt(raw, 8);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const tarPathFromHeader = (header: Uint8Array): string => {
	const name = bytesToString(header.subarray(0, 100));
	const prefix = bytesToString(header.subarray(345, 500));
	return prefix === '' ? name : `${prefix}/${name}`;
};

export const tarLinkPathFromHeader = (header: Uint8Array): string =>
	bytesToString(header.subarray(157, 257));

const trimExtendedPath = (bytes: Uint8Array): string => {
	const value = Buffer.from(bytes).toString('utf8').replace(/\n$/g, '');
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1;
	return value.slice(0, end);
};

/** Reject paths that would escape the extraction target: absolute,
 *  drive-qualified, NUL- or backslash-bearing, `.`-only, or carrying a
 *  `..` segment. Applied producer-side (relPaths) and consumer-side
 *  (every resolved entry path + hardlink/symlink target). */
export const isSafeArchivePath = (entryPath: string): boolean => {
	if (
		entryPath === '' ||
		entryPath === '.' ||
		entryPath.includes('\0') ||
		entryPath.includes('\\') ||
		entryPath.startsWith('/') ||
		/^[A-Za-z]:/.test(entryPath)
	) {
		return false;
	}
	const meaningfulSegments = entryPath
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	return meaningfulSegments.length > 0 && !meaningfulSegments.includes('..');
};

export const parsePaxRecords = (bytes: Uint8Array): Record<string, string> => {
	const text = Buffer.from(bytes).toString('utf8');
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < text.length) {
		const space = text.indexOf(' ', offset);
		if (space === -1) break;
		const lengthText = text.slice(offset, space);
		const recordLength = Number.parseInt(lengthText, 10);
		if (!Number.isSafeInteger(recordLength) || recordLength <= 0) break;
		const record = text.slice(space + 1, offset + recordLength).replace(/\n$/g, '');
		const eq = record.indexOf('=');
		if (eq > 0) {
			records[record.slice(0, eq)] = record.slice(eq + 1);
		}
		offset += recordLength;
	}
	return records;
};

// ---------------------------------------------------------------------------
// Streaming block reader.
// ---------------------------------------------------------------------------

/** A resolved tar entry, after any pax `x` / gnu `L`/`K`
 *  extended-header has been applied to its path and link target. */
export interface TarEntry {
	/** Effective entry path (pax/gnu-overridden when present). */
	readonly path: string;
	/** Effective hardlink/symlink target (pax/gnu-overridden when
	 *  present); empty for non-link entries. */
	readonly linkPath: string;
	/** One-character ustar typeflag (`'0'` regular, `'1'` hardlink,
	 *  `'2'` symlink, `'5'` directory, …). */
	readonly typeflag: string;
	/** Declared content size in bytes (unpadded). */
	readonly size: number;
}

export type TarEntryDisposition = 'skip' | 'capture' | 'stop';

/** What the reader should do with one resolved entry's body. `'skip'`
 *  advances past the (padded) body without buffering; `'capture'`
 *  buffers the body and invokes `onContent(entry, body)` when complete;
 *  `'stop'` ends the scan immediately (the body is not consumed). */
export interface TarEntryDirective {
	readonly disposition: TarEntryDisposition;
}

const SKIP: TarEntryDirective = { disposition: 'skip' };
const STOP: TarEntryDirective = { disposition: 'stop' };
export const skipEntry = (): TarEntryDirective => SKIP;
export const captureEntry = (): TarEntryDirective => ({ disposition: 'capture' });
export const stopScan = (): TarEntryDirective => STOP;

type ExtendedKind = 'pax-local' | 'pax-global' | 'gnu-path' | 'gnu-link';

interface BufferingContent {
	readonly kind: 'extended' | 'captured';
	readonly extendedKind: ExtendedKind | null;
	readonly entry: TarEntry | null;
	readonly size: number;
	readonly paddedSize: number;
	readonly chunks: Array<Uint8Array>;
	readonly contentBytesRead: number;
	readonly totalBytesRead: number;
}

/** Streaming parser state. Construct once per stream via
 *  `makeTarReaderState`, feed every chunk to `processTarChunk`, then
 *  call `finishTarReader` after EOF. */
export interface TarReaderState {
	buffer: Uint8Array;
	skipRemaining: number;
	content: BufferingContent | null;
	pendingPath: string | null;
	pendingLinkPath: string | null;
	stopped: boolean;
}

export const makeTarReaderState = (): TarReaderState => ({
	buffer: new Uint8Array(0),
	skipRemaining: 0,
	content: null,
	pendingPath: null,
	pendingLinkPath: null,
	stopped: false,
});

/** Caller hooks. `onEntry` decides the per-entry directive; `onContent`
 *  receives the buffered body for `'capture'` entries. Both may return
 *  an error of the caller's `E` type to abort the scan. */
export interface TarReaderHooks<E> {
	readonly onEntry: (entry: TarEntry) => TarEntryDirective | E;
	readonly onContent?: (entry: TarEntry, body: Uint8Array) => null | E;
	/** Raised when a pax/gnu extended record is invalid (oversized, or a
	 *  global pax path/linkpath which is not honored). Lets the caller
	 *  brand the failure with its own tagged-error type. */
	readonly onExtendedError: (detail: string) => E;
}

const isDirective = (value: unknown): value is TarEntryDirective =>
	typeof value === 'object' &&
	value !== null &&
	'disposition' in value &&
	((value as { disposition: unknown }).disposition === 'skip' ||
		(value as { disposition: unknown }).disposition === 'capture' ||
		(value as { disposition: unknown }).disposition === 'stop');

const flattenChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array =>
	chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

const applyExtended = <E>(
	state: TarReaderState,
	content: BufferingContent,
	hooks: TarReaderHooks<E>,
): E | null => {
	const bytes = flattenChunks(content.chunks);
	if (content.extendedKind === 'gnu-path') {
		state.pendingPath = trimExtendedPath(bytes);
		return null;
	}
	if (content.extendedKind === 'gnu-link') {
		state.pendingLinkPath = trimExtendedPath(bytes);
		return null;
	}
	const records = parsePaxRecords(bytes);
	if (
		content.extendedKind === 'pax-global' &&
		(records.path !== undefined || records.linkpath !== undefined)
	) {
		return hooks.onExtendedError('global pax path/linkpath records are not supported');
	}
	if (content.extendedKind === 'pax-local') {
		if (records.path !== undefined) state.pendingPath = records.path;
		if (records.linkpath !== undefined) state.pendingLinkPath = records.linkpath;
	}
	return null;
};

/**
 * Feed one stream chunk to the reader. Resolves as many complete entries
 * as the accumulated buffer allows, invoking `hooks.onEntry` (and
 * `hooks.onContent` for captured bodies). Returns a caller-typed error
 * on the first hook failure or invalid extended record, else `null`.
 *
 * Returns once `state.stopped` is set (a `'stop'` directive) so callers
 * draining via a `takeUntil`-style stream can short-circuit.
 */
export const processTarChunk = <E>(
	state: TarReaderState,
	chunk: Uint8Array,
	hooks: TarReaderHooks<E>,
): E | null => {
	if (state.stopped) return null;
	// Fast path: mid-skip over a large body and this whole chunk is
	// consumed by the skip. Avoids O(N²) concat across a multi-MB body
	// streamed in small chunks. The buffer must be empty so byte order
	// is preserved relative to the parser.
	if (state.content === null && state.skipRemaining >= chunk.length && state.buffer.length === 0) {
		state.skipRemaining -= chunk.length;
		return null;
	}
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
				if (completed.kind === 'extended') {
					const error = applyExtended(state, completed, hooks);
					if (error !== null) return error;
				} else if (hooks.onContent !== undefined && completed.entry !== null) {
					const error = hooks.onContent(completed.entry, flattenChunks(completed.chunks));
					if (error !== null) return error;
				}
			}
			continue;
		}
		if (state.skipRemaining > 0) {
			const take = Math.min(state.skipRemaining, state.buffer.length);
			state.skipRemaining -= take;
			state.buffer = consumeBytes(state.buffer, take);
			continue;
		}
		if (state.buffer.length < TAR_BLOCK_SIZE) return null;
		const header = state.buffer.subarray(0, TAR_BLOCK_SIZE);
		state.buffer = consumeBytes(state.buffer, TAR_BLOCK_SIZE);
		if (isZeroBlock(header)) continue;

		const size = parseTarSize(header);
		if (size === null) return hooks.onExtendedError('tar entry has an invalid size header');
		const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
		const typeflag = String.fromCharCode(header[156] ?? 0).replace('\0', '');
		if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K') {
			if (size > MAX_TAR_EXTENDED_PATH_BYTES) {
				return hooks.onExtendedError('tar extended path record is too large');
			}
			state.content = {
				kind: 'extended',
				extendedKind:
					typeflag === 'x'
						? 'pax-local'
						: typeflag === 'g'
							? 'pax-global'
							: typeflag === 'L'
								? 'gnu-path'
								: 'gnu-link',
				entry: null,
				size,
				paddedSize,
				chunks: [],
				contentBytesRead: 0,
				totalBytesRead: 0,
			};
			continue;
		}

		const entryPath = state.pendingPath ?? tarPathFromHeader(header);
		state.pendingPath = null;
		const linkPath = state.pendingLinkPath ?? tarLinkPathFromHeader(header);
		state.pendingLinkPath = null;
		const entry: TarEntry = { path: entryPath, linkPath, typeflag, size };

		const directiveOrError = hooks.onEntry(entry);
		if (!isDirective(directiveOrError)) return directiveOrError;
		if (directiveOrError.disposition === 'stop') {
			state.stopped = true;
			return null;
		}
		if (directiveOrError.disposition === 'capture') {
			state.content = {
				kind: 'captured',
				extendedKind: null,
				entry,
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
	return null;
};

/** Post-EOF structural check. Returns a caller-typed error if the
 *  stream ended mid-extended-header, mid-body, or with a partial header
 *  block (a trailing zero block tail is fine). */
export const finishTarReader = <E>(
	state: TarReaderState,
	mkError: (detail: string) => E,
): E | null => {
	if (state.stopped) return null;
	if (state.content !== null) {
		return mkError(
			state.content.kind === 'extended'
				? 'tar ended inside an extended header'
				: 'tar ended inside file content',
		);
	}
	if (state.skipRemaining !== 0) return mkError('tar ended inside file content');
	if (state.buffer.length !== 0 && !isZeroBlock(state.buffer)) {
		return mkError('tar ended with a partial header');
	}
	return null;
};
