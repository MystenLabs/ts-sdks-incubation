import { existsSync, readFileSync } from 'node:fs';

import { Effect, Schema, Stream, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';

import type { SubscribableState } from '../../projection.ts';
import { endpointKey, pluginKey } from '../../brand.ts';
import { atomicWriteJson } from '../atomic-write.ts';

export const PROJECTION_SNAPSHOT_FILE_NAME = 'projection.v1.json';

export const projectionSnapshotPath = (stackRoot: string): string =>
	`${stackRoot}/${PROJECTION_SNAPSHOT_FILE_NAME}`;

const SeveritySchema = Schema.Literals(['warn', 'error', 'fatal']);
const LogLevelSchema = Schema.Literals(['info', 'warn', 'error']);
const LifecycleStatusSchema = Schema.Literals([
	'pending',
	'acquiring',
	'ready',
	'failed',
	'stopping',
	'stopped',
	'done',
]);
const PluginKindSchema = Schema.Literals([
	'leaf-long-running',
	'leaf-one-shot',
	'composite',
	'hidden-leaf',
	'renderer',
]);
const CyclePhaseSchema = Schema.Literals(['booting', 'running', 'restarting', 'shutting-down']);
const RebootCostSchema = Schema.Literals(['cheap', 'moderate', 'heavy']);

const StructuredErrorSchema = Schema.Struct({
	at: Schema.Number,
	pluginKey: Schema.NullOr(Schema.String),
	tag: Schema.String,
	summary: Schema.String,
	chain: Schema.Array(Schema.String),
	severity: SeveritySchema,
});

const EndpointSchema = Schema.Struct({
	endpointKey: Schema.String,
	name: Schema.String,
	url: Schema.String,
	displayUrl: Schema.NullOr(Schema.String),
	wireProtocol: Schema.String,
	registeredAt: Schema.Number,
});

const RowSchema = Schema.Struct({
	key: Schema.String,
	kind: PluginKindSchema,
	status: LifecycleStatusSchema,
	phase: Schema.NullOr(Schema.String),
	lastError: Schema.NullOr(StructuredErrorSchema),
	logTail: Schema.Struct({
		lines: Schema.Array(Schema.String),
		level: LogLevelSchema,
		truncated: Schema.Boolean,
	}),
	endpoints: Schema.Array(Schema.String),
	compositeChildren: Schema.NullOr(Schema.Array(Schema.String)),
	selectiveRestartHighlight: Schema.Boolean,
	narrationByContributor: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
	rebootCost: Schema.NullOr(RebootCostSchema),
	displayHint: Schema.Unknown,
});

const BuildEntrySchema = Schema.Struct({
	pluginKey: Schema.NullOr(Schema.String),
	phase: Schema.String,
	progress: Schema.String,
	startedAt: Schema.Number,
});

const SubscribableStateSchema = Schema.Struct({
	identity: Schema.Struct({
		app: Schema.String,
		stack: Schema.String,
		network: Schema.String,
	}),
	cycle: Schema.Struct({
		id: Schema.Number,
		startedAt: Schema.Number,
		phase: CyclePhaseSchema,
	}),
	rows: Schema.Array(RowSchema),
	endpoints: Schema.Array(EndpointSchema),
	errors: Schema.Array(StructuredErrorSchema),
	lastEvent: Schema.Struct({
		seq: Schema.Number,
		at: Schema.Number,
	}),
	stackBuild: Schema.Array(BuildEntrySchema),
});

export const ProjectionSnapshotSchema = Schema.Struct({
	version: Schema.Literal(1),
	state: SubscribableStateSchema,
});

type PersistedSubscribableState = Schema.Schema.Type<typeof SubscribableStateSchema>;
type PersistedStructuredError = PersistedSubscribableState['errors'][number];

const rebrandStructuredError = (error: PersistedStructuredError) => ({
	...error,
	pluginKey: error.pluginKey === null ? null : pluginKey(error.pluginKey),
});

const rebrandPersistedState = (state: PersistedSubscribableState): SubscribableState => ({
	...state,
	rows: state.rows.map((row) => ({
		...row,
		key: pluginKey(row.key),
		lastError: row.lastError === null ? null : rebrandStructuredError(row.lastError),
		endpoints: row.endpoints.map(endpointKey),
		compositeChildren: row.compositeChildren?.map(pluginKey) ?? null,
	})),
	endpoints: state.endpoints.map((endpoint) => ({
		...endpoint,
		endpointKey: endpointKey(endpoint.endpointKey),
	})),
	errors: state.errors.map(rebrandStructuredError),
	stackBuild: state.stackBuild.map((entry) => ({
		...entry,
		pluginKey: entry.pluginKey === null ? null : pluginKey(entry.pluginKey),
	})),
});

export const writeProjectionSnapshot = (
	stackRoot: string,
	state: SubscribableState,
): Effect.Effect<void> =>
	atomicWriteJson(projectionSnapshotPath(stackRoot), ProjectionSnapshotSchema, {
		version: 1 as const,
		state,
	}).pipe(
		Effect.provide(NodeFileSystem.layer),
		Effect.catch(() => Effect.void),
	);

export const persistProjectionChanges = (
	stackRoot: string,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* writeProjectionSnapshot(stackRoot, yield* SubscriptionRef.get(ref));
		yield* Stream.runForEach(SubscriptionRef.changes(ref), (state) =>
			writeProjectionSnapshot(stackRoot, state),
		);
	});

export const readProjectionSnapshot = (stackRoot: string): SubscribableState | null => {
	const path = projectionSnapshotPath(stackRoot);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		return rebrandPersistedState(Schema.decodeUnknownSync(ProjectionSnapshotSchema)(parsed).state);
	} catch {
		return null;
	}
};
