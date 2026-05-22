import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { Effect, Schema } from 'effect';

import {
	SnapshotLayout,
	SnapshotMetadataSchema,
	parseSnapshotId,
} from '../orchestrators/snapshot/index.ts';
import type {
	SnapshotEntry,
	SnapshotReader,
	SnapshotResolveResult,
} from '../surfaces/cli/commands/snapshot.ts';

const decodeSnapshotMetadata = Schema.decodeUnknownSync(SnapshotMetadataSchema);

export interface SnapshotReaderIdentity {
	readonly stackRoot: string;
}

export const makeSnapshotReader = (identity: SnapshotReaderIdentity): SnapshotReader => {
	const readEntries = (): ReadonlyArray<SnapshotEntry> => {
		const snapshotDir = resolvePath(identity.stackRoot, 'snapshots');
		if (!existsSync(snapshotDir)) return [];
		return readdirSync(snapshotDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
			.flatMap((entry) => {
				const parsedEntryId = parseSnapshotId(entry.name);
				if (parsedEntryId === null) return [];
				const dir = resolvePath(snapshotDir, entry.name);
				const fallbackCreatedAt = statSync(dir).mtimeMs;
				const metaPath = resolvePath(dir, SnapshotLayout.metaFile);
				if (!existsSync(metaPath)) {
					return [
							{
								snapshotId: parsedEntryId,
								name: null,
								createdAt: fallbackCreatedAt,
								size: null,
							} satisfies SnapshotEntry,
					];
				}
				try {
					const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as unknown;
					const meta = decodeSnapshotMetadata(parsed);
					return [
							{
								snapshotId: parsedEntryId,
								name: meta.label,
								createdAt: meta.createdAt,
								size: null,
							} satisfies SnapshotEntry,
					];
				} catch {
					return [
							{
								snapshotId: parsedEntryId,
								name: null,
								createdAt: fallbackCreatedAt,
								size: null,
							} satisfies SnapshotEntry,
					];
				}
			});
	};
	return {
		list: () =>
			Effect.try({
				try: readEntries,
				catch: (cause) => cause,
			}).pipe(Effect.orElseSucceed(() => [])),
		resolve: (snapshotRef) =>
			Effect.try({
				try: (): SnapshotResolveResult => {
					const entries = readEntries();
					const byId = entries.find((entry) => entry.snapshotId === snapshotRef);
					if (byId !== undefined) return { tag: 'found', entry: byId };
					const byName = entries.filter((entry) => entry.name === snapshotRef);
					if (byName.length === 0) return { tag: 'not-found' };
					if (byName.length === 1) return { tag: 'found', entry: byName[0]! };
					return { tag: 'ambiguous', snapshotRef, matches: byName };
				},
				catch: (cause) => cause,
			}).pipe(Effect.orElseSucceed((): SnapshotResolveResult => ({ tag: 'not-found' }))),
	};
};
