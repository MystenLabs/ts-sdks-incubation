import { existsSync, readFileSync } from 'node:fs';

import { Effect, Schema, Stream, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';

import type { SubscribableState } from '../../projection.ts';
import { endpointKey, pluginKey } from '../../brand.ts';
import { versionedDocSchema } from '../../versioned-doc-schema.ts';
import { atomicWriteJson } from '../atomic-write.ts';
import { logWarningAndIgnore } from '../observability/ignore-with-log.ts';
import { decodeJsonTextSync } from '../runtime-decode.ts';

export const PROJECTION_SNAPSHOT_FILE_NAME = 'projection.v4.json';

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
const PluginRoleSchema = Schema.Literals(['service', 'task']);
const CyclePhaseSchema = Schema.Literals(['booting', 'running', 'restarting', 'shutting-down']);
const RowSectionSchema = Schema.Literals([
	'service',
	'package',
	'account',
	'action',
	'app',
	'other',
]);

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
	pluginKey: Schema.String,
	name: Schema.String,
	url: Schema.String,
	displayUrl: Schema.NullOr(Schema.String),
	wireProtocol: Schema.Literals(['http', 'h2c', 'tcp']),
	registeredAt: Schema.Number,
});

export const AccountProjectionSchema = Schema.Struct({
	key: Schema.String,
	rowKey: Schema.NullOr(Schema.String),
	name: Schema.String,
	address: Schema.NullOr(Schema.String),
	scheme: Schema.NullOr(Schema.Literals(['ed25519', 'secp256k1', 'secp256r1'])),
	source: Schema.NullOr(Schema.Literals(['real', 'impersonate'])),
	funding: Schema.Struct({
		status: Schema.Literals(['pending', 'funded', 'skipped', 'failed', 'unknown']),
		balanceMist: Schema.NullOr(Schema.String),
		requestedMist: Schema.NullOr(Schema.String),
		entries: Schema.optional(
			Schema.Array(
				Schema.Struct({
					coin: Schema.String,
					fullCoinType: Schema.String,
					amount: Schema.String,
					// Mirrors `AccountProjection.funding.entries[].status` in
					// `substrate/projection.ts`. `'already-satisfied'` is
					// the pre-existing-balance short-circuit emitted by the
					// account funding pass — semantically a success, kept
					// distinct from `'funded'` so renderers can surface the
					// cached-vs-fresh distinction.
					status: Schema.Literals(['funded', 'already-satisfied', 'skipped']),
				}),
			),
		),
	}),
	walletVisible: Schema.Boolean,
	updatedAt: Schema.Number,
});

export const PackageProjectionSchema = Schema.Struct({
	key: Schema.String,
	rowKey: Schema.NullOr(Schema.String),
	name: Schema.String,
	kind: Schema.Literals(['local', 'known']),
	packageId: Schema.String,
	upgradeCapId: Schema.NullOr(Schema.String),
	mvrPlaceholder: Schema.String,
	sourcePath: Schema.NullOr(Schema.String),
	updatedAt: Schema.Number,
});

const RowSchema = Schema.Struct({
	key: Schema.String,
	role: PluginRoleSchema,
	status: LifecycleStatusSchema,
	phase: Schema.NullOr(Schema.String),
	lastError: Schema.NullOr(StructuredErrorSchema),
	logTail: Schema.Struct({
		lines: Schema.Array(Schema.String),
		level: LogLevelSchema,
		truncated: Schema.Boolean,
	}),
	endpoints: Schema.Array(Schema.String),
	selectiveRestartHighlight: Schema.Boolean,
	section: RowSectionSchema,
	endpointSection: RowSectionSchema,
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
	accounts: Schema.Array(AccountProjectionSchema),
	packages: Schema.Array(PackageProjectionSchema),
	errors: Schema.Array(StructuredErrorSchema),
	lastEvent: Schema.Struct({
		seq: Schema.Number,
		at: Schema.Number,
	}),
	stackBuild: Schema.Array(BuildEntrySchema),
});

export const ProjectionSnapshotSchema = versionedDocSchema(4, {
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
	})),
	endpoints: state.endpoints.map((endpoint) => ({
		...endpoint,
		endpointKey: endpointKey(endpoint.endpointKey),
		pluginKey: pluginKey(endpoint.pluginKey),
	})),
	accounts: state.accounts.map((account) => ({
		...account,
		key: account.key as `account/${string}`,
		rowKey: account.rowKey === null ? null : pluginKey(account.rowKey),
	})),
	packages: state.packages.map((pkg) => ({
		...pkg,
		key: pkg.key as `package/${string}`,
		rowKey: pkg.rowKey === null ? null : pluginKey(pkg.rowKey),
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
		version: 4 as const,
		state,
	}).pipe(
		Effect.provide(NodeFileSystem.layer),
		// Best-effort: a snapshot write failure must not fail the caller
		// (the projection is a re-derivable read model). But a bare
		// `Effect.catch(() => Effect.void)` hid disk-full / permission
		// faults entirely — leave the cause in the log stream (§18) so a
		// persistently-failing snapshot is diagnosable.
		logWarningAndIgnore('projection snapshot write failed', {
			path: projectionSnapshotPath(stackRoot),
		}),
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
		const snapshot = decodeJsonTextSync(ProjectionSnapshotSchema, readFileSync(path, 'utf8'), {
			source: path,
			mkError: (issue) => issue,
		});
		return rebrandPersistedState(snapshot.state);
	} catch {
		return null;
	}
};
