import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { Effect, Schema } from 'effect';

import {
	SnapshotLayout,
	SnapshotMetadataSchema,
	parseSnapshotId,
} from '../orchestrators/snapshot/index.ts';
import type { SnapshotEntry, SnapshotReader } from '../surfaces/cli/commands/snapshot.ts';

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
							label: null,
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
							label: meta.label,
							createdAt: meta.createdAt,
							size: null,
						} satisfies SnapshotEntry,
					];
				} catch {
					return [
						{
							snapshotId: parsedEntryId,
							label: null,
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
				try: () =>
					readEntries().find(
						(entry) => entry.snapshotId === snapshotRef || entry.label === snapshotRef,
					) ?? null,
				catch: (cause) => cause,
			}).pipe(Effect.orElseSucceed(() => null)),
	};
};
