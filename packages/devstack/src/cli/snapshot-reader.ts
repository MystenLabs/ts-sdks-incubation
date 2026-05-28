import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { Effect } from 'effect';

import {
	SnapshotLayout,
	SnapshotMetadataSchema,
	parseSnapshotId,
} from '../orchestrators/snapshot/index.ts';
import { decodeJsonTextSync } from '../substrate/runtime/runtime-decode.ts';
import type {
	SnapshotEntry,
	SnapshotReader,
	SnapshotResolveResult,
} from '../surfaces/cli/commands/snapshot.ts';

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
					const meta = decodeJsonTextSync(SnapshotMetadataSchema, readFileSync(metaPath, 'utf8'), {
						source: metaPath,
						mkError: (issue) => issue,
					});
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
					// Resolve id-vs-name in a single pass so a ref that matches
					// BOTH an id AND a name (different entries) surfaces as
					// ambiguous instead of silently shadowing the name match
					// with the id match. The auto-mint format
					// (`snap-<ts>-<uuid>`) satisfies the same grammar as a
					// user-supplied name, so id-first fall-through was a real
					// foot-gun: a user typing a label that happened to equal
					// an existing snapshot id would restore the wrong artifact.
					const byId = entries.find((entry) => entry.snapshotId === snapshotRef);
					const byName = entries.filter((entry) => entry.name === snapshotRef);

					// Same entry matched by both axes (unusual but well-defined):
					// caller's intent is unambiguous because there is exactly
					// one matching artifact.
					const distinct = new Map<string, SnapshotEntry>();
					if (byId !== undefined) distinct.set(byId.snapshotId, byId);
					for (const entry of byName) distinct.set(entry.snapshotId, entry);

					if (distinct.size === 0) return { tag: 'not-found' };
					if (distinct.size === 1) {
						const only = distinct.values().next().value as SnapshotEntry;
						return { tag: 'found', entry: only };
					}
					return {
						tag: 'ambiguous',
						snapshotRef,
						matches: Array.from(distinct.values()),
					};
				},
				catch: (cause) => cause,
			}).pipe(Effect.orElseSucceed((): SnapshotResolveResult => ({ tag: 'not-found' }))),
	};
};
