// Type guard for `EngineCommand` records arriving over the
// cross-process command channel. Exhaustive switch over the union's
// tag — a new variant added without a corresponding case here fails
// typecheck on the `_exhaustive: never` proof so we never drift.

import type { EngineCommand } from '../../substrate/events.ts';

const hasString = (value: Record<string, unknown>, key: string): boolean =>
	typeof value[key] === 'string';

export const isEngineCommand = (value: unknown): value is EngineCommand => {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	const tag = record.tag;
	if (typeof tag !== 'string') return false;
	const knownTag = tag as EngineCommand['tag'];
	switch (knownTag) {
		case 'stack.start':
		case 'stack.stop':
		case 'stack.restart':
		case 'codegen.requested':
		case 'snapshot.list':
		case 'wipe.requested':
		case 'prune.requested':
		case 'shutdown.requested':
			return true;
		case 'snapshot.restore':
		case 'snapshot.delete':
			return hasString(record, 'snapshotId');
		case 'advance-clock.requested':
			return typeof record.toMillis === 'number';
		case 'shutdown.hardKillRequested':
			return (
				(record.signal === 'SIGINT' || record.signal === 'SIGTERM') &&
				typeof record.exitCode === 'number' &&
				typeof record.at === 'number'
			);
		case 'selective-restart.requested':
			return hasString(record, 'pluginKey');
		case 'apply.requested':
			return record.pluginKey === undefined || typeof record.pluginKey === 'string';
		case 'snapshot.capture':
			return (
				(record.snapshotId === undefined || typeof record.snapshotId === 'string') &&
				(record.name === undefined || typeof record.name === 'string')
			);
		default: {
			const _exhaustive: never = knownTag;
			void _exhaustive;
			return false;
		}
	}
};
