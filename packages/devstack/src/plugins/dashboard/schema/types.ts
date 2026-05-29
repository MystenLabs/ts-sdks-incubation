// Dashboard object types — real Pothos object refs over the projection.
//
// Sources are the substrate projection shapes (Row, Endpoint,
// AccountProjection, …). Service/Endpoint/Account/Package are registered
// as relay Nodes via `builder.node`, with an opaque global id derived from
// their natural key and a `loadOne` that re-finds them in the current
// snapshot (read from the request's `ctx.state`) so the auto-generated
// `node`/`nodes` queries resolve.
//
// `StackState` and `HealthSummary` are computed views over a snapshot —
// `StackState` carries the snapshot itself as its source so nested
// resolvers (e.g. Service.endpoints) can join against sibling arrays.

import { Effect, SubscriptionRef } from 'effect';
import { builder } from './builder.ts';
import {
	AccountScheme,
	AccountSource,
	DeepbookMode,
	ErrorSeverity,
	FundingStatus,
	Health as HealthEnum,
	LifecycleStatus,
	LogLevel,
	PackageKind,
	PluginRole,
	RowSection,
	WireProtocol,
} from './enums.ts';
import type { Health } from './enums.ts';
import type {
	ControlPlaneCoinCap,
	ControlPlaneDeepbookInfo,
	ControlPlaneDeepbookPool,
	ControlPlanePostgresStats,
	ControlPlanePostgresTable,
	ControlPlaneSealInfo,
	ControlPlaneSealKeyServer,
	ControlPlaneSnapshotEntry,
} from '../../../substrate/runtime/control-plane/service.ts';
import type {
	LogRecord,
	SpanRecord,
} from '../../../substrate/runtime/observability/index.ts';
import type {
	AccountProjection,
	BuildEntry as BuildEntryShape,
	Endpoint as EndpointShape,
	LogTail as LogTailShape,
	PackageProjection,
	Row,
	StructuredError,
	SubscribableState,
} from '../../../substrate/projection.ts';

/** A snapshot-carrying service row. The snapshot lets `endpoints` join the
 *  row's endpoint keys against the projection's endpoint array. */
export interface ServiceSource {
	readonly row: Row;
	readonly snapshot: SubscribableState;
}

type FundingEntrySource = NonNullable<AccountProjection['funding']['entries']>[number];

export interface HealthSummarySource {
	readonly total: number;
	readonly ready: number;
	readonly active: number;
	readonly failed: number;
	readonly waiting: number;
	readonly health: Health;
}

/** Compute the stack health summary from the projection rows. `active`
 *  counts rows mid-flight (acquiring/stopping); `waiting` counts rows that
 *  have not started (pending). Overall `health` is `failed`→blocked,
 *  any-active→active, all-ready (with ≥1 row)→ready, otherwise empty. */
export const computeHealthSummary = (rows: ReadonlyArray<Row>): HealthSummarySource => {
	let ready = 0;
	let active = 0;
	let failed = 0;
	let waiting = 0;
	for (const row of rows) {
		switch (row.status) {
			case 'ready':
			case 'done':
			case 'stopped':
				ready += 1;
				break;
			case 'acquiring':
			case 'stopping':
				active += 1;
				break;
			case 'failed':
				failed += 1;
				break;
			case 'pending':
				waiting += 1;
				break;
		}
	}
	const total = rows.length;
	const health: Health =
		failed > 0
			? 'blocked'
			: active > 0
				? 'active'
				: total > 0 && ready === total
					? 'ready'
					: 'empty';
	return { total, ready, active, failed, waiting, health };
};

const readSnapshot = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
): Promise<SubscribableState> => Effect.runPromise(SubscriptionRef.get(ref));

// --- Identity / Cycle ---------------------------------------------------
export const Identity = builder.objectRef<SubscribableState['identity']>('Identity').implement({
	description: 'Stack identity triple (app/stack/network).',
	fields: (t) => ({
		app: t.exposeString('app'),
		stack: t.exposeString('stack'),
		network: t.exposeString('network'),
	}),
});

export const Cycle = builder.objectRef<SubscribableState['cycle']>('Cycle').implement({
	description: 'The current boot/restart cycle.',
	fields: (t) => ({
		id: t.exposeInt('id'),
		startedAt: t.exposeFloat('startedAt'),
		// Carried as String: the raw union ('booting'|…|'shutting-down') is the
		// wire contract, and 'shutting-down' is not a valid GraphQL enum name.
		phase: t.field({ type: 'String', resolve: (c) => c.phase }),
	}),
});

// --- Endpoint (Node) ----------------------------------------------------
export const Endpoint = builder.objectRef<EndpointShape>('Endpoint');
builder.node(Endpoint, {
	description: 'A routed endpoint contributed by a plugin.',
	id: { resolve: (e) => e.endpointKey },
	loadOne: async (id, ctx) => {
		const snapshot = await readSnapshot(ctx.state);
		return snapshot.endpoints.find((e) => e.endpointKey === id) ?? null;
	},
	fields: (t) => ({
		endpointKey: t.exposeString('endpointKey'),
		pluginKey: t.exposeString('pluginKey'),
		name: t.exposeString('name'),
		url: t.exposeString('url'),
		displayUrl: t.exposeString('displayUrl', { nullable: true }),
		wireProtocol: t.field({ type: WireProtocol, resolve: (e) => e.wireProtocol }),
		registeredAt: t.exposeFloat('registeredAt'),
	}),
});

// --- LogTail / StackError ----------------------------------------------
export const LogTail = builder.objectRef<LogTailShape>('LogTail').implement({
	description: 'The tail of a plugin log stream.',
	fields: (t) => ({
		lines: t.exposeStringList('lines'),
		level: t.field({ type: LogLevel, resolve: (l) => l.level }),
		truncated: t.exposeBoolean('truncated'),
	}),
});

export const StackError = builder.objectRef<StructuredError>('StackError').implement({
	description: 'A structured error reported by a plugin or the engine.',
	fields: (t) => ({
		at: t.exposeFloat('at'),
		pluginKey: t.exposeString('pluginKey', { nullable: true }),
		tag: t.exposeString('tag'),
		summary: t.exposeString('summary'),
		chain: t.exposeStringList('chain'),
		severity: t.field({ type: ErrorSeverity, resolve: (e) => e.severity }),
	}),
});

// --- Service (Node, wraps a Row) ---------------------------------------
export const Service = builder.objectRef<ServiceSource>('Service');
builder.node(Service, {
	description: 'A visible plugin instance (one projection row).',
	id: { resolve: (s) => s.row.key },
	loadOne: async (id, ctx) => {
		const snapshot = await readSnapshot(ctx.state);
		const row = snapshot.rows.find((r) => r.key === id);
		return row ? { row, snapshot } : null;
	},
	fields: (t) => ({
		key: t.string({ resolve: (s) => s.row.key }),
		role: t.field({ type: PluginRole, resolve: (s) => s.row.role }),
		status: t.field({ type: LifecycleStatus, resolve: (s) => s.row.status }),
		section: t.field({ type: RowSection, resolve: (s) => s.row.section }),
		endpointSection: t.field({ type: RowSection, resolve: (s) => s.row.endpointSection }),
		phase: t.string({ nullable: true, resolve: (s) => s.row.phase }),
		selectiveRestartHighlight: t.boolean({
			resolve: (s) => s.row.selectiveRestartHighlight,
		}),
		lastError: t.field({
			type: StackError,
			nullable: true,
			resolve: (s) => s.row.lastError,
		}),
		logTail: t.field({ type: LogTail, resolve: (s) => s.row.logTail }),
		endpoints: t.field({
			type: [Endpoint],
			description: "The row's endpoints, joined from the snapshot by key + pluginKey.",
			resolve: (s) => {
				const keys = new Set<string>(s.row.endpoints);
				return s.snapshot.endpoints.filter(
					(e) => keys.has(e.endpointKey) && e.pluginKey === s.row.key,
				);
			},
		}),
	}),
});

// --- Funding ------------------------------------------------------------
export const FundingEntry = builder.objectRef<FundingEntrySource>('FundingEntry').implement({
	description: 'One coin-type funding outcome for an account.',
	fields: (t) => ({
		coin: t.exposeString('coin'),
		fullCoinType: t.exposeString('fullCoinType'),
		amount: t.exposeString('amount'),
		// String for the same reason as Cycle.phase: 'already-satisfied' is not
		// a valid GraphQL enum name; the raw union string is the wire contract.
		status: t.field({ type: 'String', resolve: (e) => e.status }),
	}),
});

export const AccountFunding = builder
	.objectRef<AccountProjection['funding']>('AccountFunding')
	.implement({
		description: 'Funding state for an account.',
		fields: (t) => ({
			status: t.field({ type: FundingStatus, resolve: (f) => f.status }),
			balanceMist: t.exposeString('balanceMist', { nullable: true }),
			requestedMist: t.exposeString('requestedMist', { nullable: true }),
			entries: t.field({
				type: [FundingEntry],
				resolve: (f) => f.entries ?? [],
			}),
		}),
	});

// --- Account (Node) -----------------------------------------------------
export const Account = builder.objectRef<AccountProjection>('Account');
builder.node(Account, {
	description: 'A managed or impersonated account.',
	id: { resolve: (a) => a.key },
	loadOne: async (id, ctx) => {
		const snapshot = await readSnapshot(ctx.state);
		return snapshot.accounts.find((a) => a.key === id) ?? null;
	},
	fields: (t) => ({
		key: t.exposeString('key'),
		rowKey: t.exposeString('rowKey', { nullable: true }),
		name: t.exposeString('name'),
		address: t.exposeString('address', { nullable: true }),
		scheme: t.field({ type: AccountScheme, nullable: true, resolve: (a) => a.scheme }),
		source: t.field({ type: AccountSource, nullable: true, resolve: (a) => a.source }),
		walletVisible: t.exposeBoolean('walletVisible'),
		updatedAt: t.exposeFloat('updatedAt'),
		funding: t.field({ type: AccountFunding, resolve: (a) => a.funding }),
	}),
});

// --- Package (Node) -----------------------------------------------------
export const Package = builder.objectRef<PackageProjection>('Package');
builder.node(Package, {
	description: 'A local or known on-chain package.',
	id: { resolve: (p) => p.key },
	loadOne: async (id, ctx) => {
		const snapshot = await readSnapshot(ctx.state);
		return snapshot.packages.find((p) => p.key === id) ?? null;
	},
	fields: (t) => ({
		key: t.exposeString('key'),
		rowKey: t.exposeString('rowKey', { nullable: true }),
		name: t.exposeString('name'),
		kind: t.field({ type: PackageKind, resolve: (p) => p.kind }),
		packageId: t.exposeString('packageId'),
		upgradeCapId: t.exposeString('upgradeCapId', { nullable: true }),
		mvrPlaceholder: t.exposeString('mvrPlaceholder'),
		sourcePath: t.exposeString('sourcePath', { nullable: true }),
		updatedAt: t.exposeFloat('updatedAt'),
	}),
});

// --- BuildEntry / LastEvent --------------------------------------------
export const BuildEntry = builder.objectRef<BuildEntryShape>('BuildEntry').implement({
	description: 'A stack build progress entry.',
	fields: (t) => ({
		pluginKey: t.exposeString('pluginKey', { nullable: true }),
		phase: t.exposeString('phase'),
		progress: t.exposeString('progress'),
		startedAt: t.exposeFloat('startedAt'),
	}),
});

export const LastEvent = builder.objectRef<SubscribableState['lastEvent']>('LastEvent').implement({
	description: 'The most recent event seq/timestamp the engine emitted.',
	fields: (t) => ({
		seq: t.exposeInt('seq'),
		at: t.exposeFloat('at'),
	}),
});

// --- HealthSummary ------------------------------------------------------
export const HealthSummary = builder.objectRef<HealthSummarySource>('HealthSummary').implement({
	description: 'Derived stack health counts.',
	fields: (t) => ({
		total: t.exposeInt('total'),
		ready: t.exposeInt('ready'),
		active: t.exposeInt('active'),
		failed: t.exposeInt('failed'),
		waiting: t.exposeInt('waiting'),
		health: t.field({ type: HealthEnum, resolve: (h) => h.health }),
	}),
});

// --- Plugin-domain object types ----------------------------------------
//
// Sources are the app-agnostic `ControlPlane*` shapes the supervisor
// populates from resolved plugin values. These cover only what the browser
// cannot reach directly: codegen capability ids, in-process plugin state,
// the snapshot catalog, and PG wire-protocol stats. Numeric counts/sizes
// are carried as Float (GraphQL Int caps at 2^31; pg sizes can exceed it).

export const SnapshotEntry = builder
	.objectRef<ControlPlaneSnapshotEntry>('SnapshotEntry')
	.implement({
		description: 'A snapshot catalog entry (orchestrator `list`).',
		fields: (t) => ({
			id: t.exposeString('id'),
			label: t.exposeString('label', { nullable: true }),
			createdAt: t.exposeFloat('createdAt', { nullable: true }),
			app: t.exposeString('app', { nullable: true }),
			stack: t.exposeString('stack', { nullable: true }),
			network: t.exposeString('network', { nullable: true }),
			participants: t.exposeStringList('participants'),
			containerCount: t.exposeInt('containerCount'),
			subtreeCount: t.exposeInt('subtreeCount'),
			corrupt: t.exposeBoolean('corrupt'),
		}),
	});

export const DeepbookPool = builder
	.objectRef<ControlPlaneDeepbookPool>('DeepbookPool')
	.implement({
		description: 'A DeepBook pool object id + coin types (prices are chain-direct).',
		fields: (t) => ({
			name: t.exposeString('name'),
			poolId: t.exposeString('poolId'),
			baseCoinType: t.exposeString('baseCoinType'),
			quoteCoinType: t.exposeString('quoteCoinType'),
		}),
	});

export const DeepbookInfo = builder
	.objectRef<ControlPlaneDeepbookInfo>('DeepbookInfo')
	.implement({
		description: 'A DeepBook deployment: registry/admin/pool ids + market-maker state.',
		fields: (t) => ({
			pluginKey: t.exposeString('pluginKey'),
			name: t.exposeString('name'),
			mode: t.field({ type: DeepbookMode, resolve: (d) => d.mode }),
			chain: t.exposeString('chain'),
			packageId: t.exposeString('packageId'),
			registryId: t.exposeString('registryId'),
			adminCapId: t.exposeString('adminCapId', { nullable: true }),
			deepTreasuryId: t.exposeString('deepTreasuryId', { nullable: true }),
			pools: t.field({ type: [DeepbookPool], resolve: (d) => d.pools }),
			marketMakerRunning: t.exposeBoolean('marketMakerRunning'),
			serverUrl: t.exposeString('serverUrl', { nullable: true }),
			indexerUrl: t.exposeString('indexerUrl', { nullable: true }),
		}),
	});

export const SealKeyServer = builder
	.objectRef<ControlPlaneSealKeyServer>('SealKeyServer')
	.implement({
		description: 'One Seal key-server config (objectId + weight).',
		fields: (t) => ({
			objectId: t.exposeString('objectId'),
			weight: t.exposeInt('weight'),
		}),
	});

export const SealInfo = builder.objectRef<ControlPlaneSealInfo>('SealInfo').implement({
	description: 'A Seal key-server deployment (objectId/threshold/mode/keyServers).',
	fields: (t) => ({
		pluginKey: t.exposeString('pluginKey'),
		// String, not enum: 'local-keygen'/'fork-known' are illegal GraphQL
		// enum value names (hyphens). The raw union string is the wire contract.
		mode: t.field({ type: 'String', resolve: (s) => s.mode }),
		objectId: t.exposeString('objectId'),
		keyServerUrl: t.exposeString('keyServerUrl'),
		keyServers: t.field({ type: [SealKeyServer], resolve: (s) => s.keyServers }),
		threshold: t.exposeInt('threshold'),
	}),
});

export const CoinCap = builder.objectRef<ControlPlaneCoinCap>('CoinCap').implement({
	description: "A coin's treasury-cap id (drives Mint) + addressing facts.",
	fields: (t) => ({
		pluginKey: t.exposeString('pluginKey'),
		symbol: t.exposeString('symbol', { nullable: true }),
		fullCoinType: t.exposeString('fullCoinType'),
		decimals: t.exposeInt('decimals'),
		// String, not enum: 'on-chain' is an illegal GraphQL enum value name.
		source: t.field({ type: 'String', resolve: (c) => c.source }),
		treasuryCapId: t.exposeString('treasuryCapId', { nullable: true }),
		packageId: t.exposeString('packageId', { nullable: true }),
	}),
});

export const PostgresTable = builder
	.objectRef<ControlPlanePostgresTable>('PostgresTable')
	.implement({
		description: 'Per-table row estimate + total size (bytes).',
		fields: (t) => ({
			schema: t.exposeString('schema'),
			name: t.exposeString('name'),
			rowEstimate: t.exposeFloat('rowEstimate'),
			totalBytes: t.exposeFloat('totalBytes'),
		}),
	});

export const PostgresStats = builder
	.objectRef<ControlPlanePostgresStats>('PostgresStats')
	.implement({
		description:
			'Postgres wire-protocol stats (db size, connections, per-table). Gathered by exec; the browser cannot speak the PG protocol.',
		fields: (t) => ({
			pluginKey: t.exposeString('pluginKey'),
			database: t.exposeString('database'),
			// Plain (password-less) DSN only — the credentialed form never leaves
			// the backend.
			plainUrl: t.exposeString('plainUrl'),
			databaseBytes: t.exposeFloat('databaseBytes'),
			connectionCount: t.exposeInt('connectionCount'),
			tables: t.field({ type: [PostgresTable], resolve: (p) => p.tables }),
			available: t.exposeBoolean('available'),
			detail: t.exposeString('detail', { nullable: true }),
		}),
	});

// --- Observability: LogRecord / SpanRecord -----------------------------
//
// Sources are the substrate observability ring records. `level` (logs) and
// `status` (spans) are carried as String, not GraphQL enums: the log level
// vocabulary (trace/debug/info/warn/error/fatal) is wider than the
// projection's row-tail LogLevel enum, and keeping it String decouples the
// queryable surface from the row-tail enum (same hyphen/illegal-enum-safe
// String pattern used by SealMode/CoinSource above). Structured `fields` /
// `attributes` are serialized to a JSON string — the schema has no JSON
// scalar and the console renders them as a detail blob.

const fieldsJson = (fields: Readonly<Record<string, unknown>>): string => {
	try {
		return JSON.stringify(fields);
	} catch {
		return '{}';
	}
};

export const LogRecordType = builder.objectRef<LogRecord>('LogRecord').implement({
	description:
		'One cross-service log record (queryable Console "Logs" tab). Fed off the same logger path as the per-row projection tail.',
	fields: (t) => ({
		seq: t.exposeFloat('seq'),
		timestampMillis: t.exposeFloat('timestampMillis'),
		// String: wider than the row-tail LogLevel enum (trace/debug/fatal).
		level: t.field({ type: 'String', resolve: (r) => r.level }),
		service: t.exposeString('service'),
		message: t.exposeString('message'),
		/** Structured fields as a JSON string (no JSON scalar in this schema). */
		fieldsJson: t.field({ type: 'String', resolve: (r) => fieldsJson(r.fields) }),
	}),
});

export const SpanRecordType = builder.objectRef<SpanRecord>('SpanRecord').implement({
	description:
		'One completed span (queryable Console "Traces" tab). Recorded by the supervisor\'s recording Tracer.',
	fields: (t) => ({
		traceId: t.exposeString('traceId'),
		spanId: t.exposeString('spanId'),
		parentId: t.exposeString('parentId', { nullable: true }),
		name: t.exposeString('name'),
		service: t.exposeString('service', { nullable: true }),
		startMillis: t.exposeFloat('startMillis'),
		durationMillis: t.exposeFloat('durationMillis'),
		// String: 'ok'/'error' kept as the raw wire contract.
		status: t.field({ type: 'String', resolve: (r) => r.status }),
		/** Flattened span attributes as a JSON string. */
		attributesJson: t.field({ type: 'String', resolve: (r) => fieldsJson(r.attributes) }),
	}),
});

// --- Observability filter inputs ---------------------------------------

export const LogFilterInput = builder.inputType('LogFilter', {
	fields: (t) => ({
		services: t.stringList({ required: false }),
		/** Levels (trace/debug/info/warn/error/fatal). Strings, not an enum
		 *  (the level vocabulary is wider than the row-tail LogLevel enum). */
		levels: t.stringList({ required: false }),
		search: t.string({ required: false }),
		sinceMillis: t.float({ required: false }),
		limit: t.int({ required: false }),
	}),
});

export const SpanFilterInput = builder.inputType('SpanFilter', {
	fields: (t) => ({
		services: t.stringList({ required: false }),
		/** Statuses ('ok' / 'error'). Strings, not an enum. */
		statuses: t.stringList({ required: false }),
		search: t.string({ required: false }),
		sinceMillis: t.float({ required: false }),
		limit: t.int({ required: false }),
	}),
});

// --- StackState (source = the snapshot itself) -------------------------
export const StackState = builder.objectRef<SubscribableState>('StackState').implement({
	description: 'A full live projection snapshot.',
	fields: (t) => ({
		identity: t.field({ type: Identity, resolve: (s) => s.identity }),
		cycle: t.field({ type: Cycle, resolve: (s) => s.cycle }),
		summary: t.field({ type: HealthSummary, resolve: (s) => computeHealthSummary(s.rows) }),
		services: t.field({
			type: [Service],
			resolve: (s) => s.rows.map((row) => ({ row, snapshot: s })),
		}),
		endpoints: t.field({ type: [Endpoint], resolve: (s) => s.endpoints }),
		accounts: t.field({ type: [Account], resolve: (s) => s.accounts }),
		packages: t.field({ type: [Package], resolve: (s) => s.packages }),
		errors: t.field({ type: [StackError], resolve: (s) => s.errors }),
		stackBuild: t.field({ type: [BuildEntry], resolve: (s) => s.stackBuild }),
		lastEvent: t.field({ type: LastEvent, nullable: true, resolve: (s) => s.lastEvent }),
	}),
});
