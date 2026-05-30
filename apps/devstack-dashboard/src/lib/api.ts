// GraphQL client for the devstack dashboard API, built on gql.tada.
//
// Every document below is type-checked against the schema introspection
// (src/lib/graphql-env.d.ts) at compile time, so result/variable shapes can't
// drift from the server. `subscribeState` streams live frames over SSE and
// `fetchState` is the one-shot/poll fallback — both normalize through the same
// `toProjection`.

import { print } from 'graphql';
import type { TadaDocumentNode } from 'gql.tada';
import { graphql, readFragment, type ResultOf } from './graphql.ts';
import type { CyclePhase, FundingEntryStatus, Projection, Row } from './types.ts';

interface GqlResult<T> {
	readonly data?: T;
	readonly errors?: ReadonlyArray<{ message: string }>;
}

/** Shape of a single mutation result on the server (`CommandResult`). */
export interface CommandResult {
	readonly ok: boolean;
	readonly command: string;
	readonly message: string | null;
}

/** Execute a typed document. Result/variables are inferred from the document. */
const execute = async <Result, Variables>(
	endpoint: string,
	document: TadaDocumentNode<Result, Variables>,
	variables?: Variables,
): Promise<Result> => {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: print(document), variables }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json = (await res.json()) as GqlResult<Result>;
	if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
	if (json.data === undefined) throw new Error('empty GraphQL response');
	return json.data;
};

// --- State document ---------------------------------------------------------
//
// One selection, shared by the `state` query and the `state` subscription via a
// fragment, so the polling and live-stream transports can never drift.

const StackStateFields = graphql(`
	fragment StackStateFields on StackState {
		identity {
			app
			stack
			network
		}
		cycle {
			id
			startedAt
			phase
		}
		services {
			key
			role
			status
			section
			endpointSection
			phase
			selectiveRestartHighlight
			logTail {
				lines
				level
				truncated
			}
			endpoints {
				endpointKey
				pluginKey
				name
				url
				displayUrl
				wireProtocol
				registeredAt
			}
			lastError {
				at
				pluginKey
				tag
				summary
				chain
				severity
			}
		}
		endpoints {
			endpointKey
			pluginKey
			name
			url
			displayUrl
			wireProtocol
			registeredAt
		}
		accounts {
			key
			rowKey
			name
			address
			scheme
			source
			walletVisible
			updatedAt
			funding {
				status
				balanceMist
				requestedMist
				entries {
					coin
					fullCoinType
					amount
					status
				}
			}
		}
		packages {
			key
			rowKey
			name
			kind
			packageId
			upgradeCapId
			mvrPlaceholder
			sourcePath
			updatedAt
		}
		errors {
			at
			pluginKey
			tag
			summary
			chain
			severity
		}
		stackBuild {
			pluginKey
			phase
			progress
			startedAt
		}
		lastEvent {
			seq
			at
		}
	}
`);

const StateQuery = graphql(
	`
		query State {
			state {
				...StackStateFields
			}
		}
	`,
	[StackStateFields],
);
const StateSubscription = graphql(
	`
		subscription StateStream {
			state {
				...StackStateFields
			}
		}
	`,
	[StackStateFields],
);

type StateFields = ResultOf<typeof StackStateFields>;
type WireService = StateFields['services'][number];
type WireAccount = StateFields['accounts'][number];

// The server returns `services` (each carrying inline `logTail`, `endpoints`,
// `lastError`); `Projection.rows` carries only endpoint *keys*, so project the
// service endpoints down to their keys.
const serviceToRow = (s: WireService): Row => ({
	key: s.key,
	role: s.role,
	status: s.status,
	phase: s.phase,
	lastError: s.lastError,
	logTail: s.logTail,
	endpoints: s.endpoints.map((e) => e.endpointKey),
	selectiveRestartHighlight: s.selectiveRestartHighlight,
	section: s.section,
	endpointSection: s.endpointSection,
});

// `funding.entries[].status` is a String scalar on the wire (its union values
// contain hyphens, illegal in GraphQL enum names); narrow it back here.
const normalizeAccount = (a: WireAccount): Projection['accounts'][number] => ({
	...a,
	funding: {
		...a.funding,
		entries: a.funding.entries.map((e) => ({
			...e,
			status: e.status as FundingEntryStatus,
		})),
	},
});

/** Normalize a `StackState` selection into the client `Projection`. */
const toProjection = (state: StateFields): Projection => ({
	identity: state.identity,
	// `cycle.phase` is a String scalar on the wire (see Cycle.phase note); narrow.
	cycle: { ...state.cycle, phase: state.cycle.phase as CyclePhase },
	rows: state.services.map(serviceToRow),
	endpoints: state.endpoints,
	accounts: state.accounts.map(normalizeAccount),
	packages: state.packages,
	errors: state.errors,
	lastEvent: state.lastEvent,
	stackBuild: state.stackBuild,
});

/** Fetch the current projection once (`services` → `rows` normalized). */
export const fetchState = async (endpoint: string): Promise<Projection> => {
	const { state } = await execute(endpoint, StateQuery);
	return toProjection(readFragment(StackStateFields, state));
};

export interface StateStreamHandlers {
	readonly onState: (projection: Projection) => void;
	readonly onError: (message: string) => void;
}

/**
 * Subscribe to live `state` frames over graphql-yoga's SSE transport (POST with
 * `Accept: text/event-stream`). Calls `onState` with each pushed projection and
 * `onError` once the stream ends or fails. Returns an unsubscribe function.
 */
export const subscribeState = (endpoint: string, handlers: StateStreamHandlers): (() => void) => {
	const controller = new AbortController();
	void streamState(endpoint, controller.signal, handlers);
	return () => controller.abort();
};

const streamState = async (
	endpoint: string,
	signal: AbortSignal,
	handlers: StateStreamHandlers,
): Promise<void> => {
	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({ query: print(StateSubscription) }),
			signal,
		});
		if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE frames are separated by a blank line.
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const data = frame
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).trim())
					.join('\n');
				if (!data) continue;
				const payload = JSON.parse(data) as GqlResult<{ state: StateFields }>;
				if (payload.errors?.length)
					throw new Error(payload.errors.map((e) => e.message).join('; '));
				if (payload.data?.state) handlers.onState(toProjection(payload.data.state));
			}
		}
		throw new Error('subscription stream ended');
	} catch (err) {
		if (signal.aborted) return;
		handlers.onError(err instanceof Error ? err.message : String(err));
	}
};

// --- Mutations --------------------------------------------------------------

const RestartDoc = graphql(`
	mutation Restart {
		restart {
			ok
			command
			message
		}
	}
`);
const RestartPluginDoc = graphql(`
	mutation RestartPlugin($pluginKey: String!) {
		restartPlugin(input: { pluginKey: $pluginKey }) {
			ok
			command
			message
		}
	}
`);
const CaptureSnapshotDoc = graphql(`
	mutation CaptureSnapshot($name: String) {
		captureSnapshot(input: { name: $name }) {
			ok
			command
			message
		}
	}
`);
const CodegenDoc = graphql(`
	mutation Codegen {
		codegen {
			ok
			command
			message
		}
	}
`);
const ApplyDoc = graphql(`
	mutation Apply($pluginKey: String) {
		apply(input: { pluginKey: $pluginKey }) {
			ok
			command
			message
		}
	}
`);

export const restartStack = (endpoint: string): Promise<CommandResult> =>
	execute(endpoint, RestartDoc).then((d) => d.restart);

export const restartPlugin = (endpoint: string, pluginKey: string): Promise<CommandResult> =>
	execute(endpoint, RestartPluginDoc, { pluginKey }).then((d) => d.restartPlugin);

export const captureSnapshot = (endpoint: string, name?: string): Promise<CommandResult> =>
	execute(endpoint, CaptureSnapshotDoc, { name: name ?? null }).then((d) => d.captureSnapshot);

export const runCodegen = (endpoint: string): Promise<CommandResult> =>
	execute(endpoint, CodegenDoc).then((d) => d.codegen);

export const applyStack = (endpoint: string, pluginKey?: string): Promise<CommandResult> =>
	execute(endpoint, ApplyDoc, { pluginKey: pluginKey ?? null }).then((d) => d.apply);

// --- New control-plane mutations --------------------------------------------

/** Outcome of a snapshot restore/delete (`SnapshotActionResult`). */
export interface SnapshotActionResult {
	readonly ok: boolean;
	readonly detail: string | null;
}

/** Outcome of a coin mint (`MintResult`); `digest` is set on success. */
export interface MintResult {
	readonly ok: boolean;
	readonly detail: string;
	readonly digest: string | null;
}

/** Variables for a mint: full coin type, recipient address, base-unit amount. */
export interface MintArgs {
	readonly coinType: string;
	readonly recipient: string;
	readonly amountBaseUnits: string;
}

/** Outcome of a faucet fund (`FundResult`). The in-process funding
 *  strategies return no digest, so `digest` is always null — `ok` reflects
 *  whether the strategy's request completed; `detail` carries the reason. */
export interface FundResult {
	readonly ok: boolean;
	readonly detail: string;
	readonly digest: string | null;
}

/** Variables for a fund request. `coinType` absent / SUI routes through the
 *  fixed-amount chain faucet (amount ignored); a WAL/DEEP coin type routes
 *  through the account-signed swap (amount honored). */
export interface FundArgs {
	readonly recipient: string;
	readonly coinType?: string;
	readonly amountBaseUnits?: string;
}

const WipeDoc = graphql(`
	mutation Wipe {
		wipe {
			ok
			command
			message
		}
	}
`);
const PruneDoc = graphql(`
	mutation Prune {
		prune {
			ok
			command
			message
		}
	}
`);
const ShutdownDoc = graphql(`
	mutation Shutdown {
		shutdown {
			ok
			command
			message
		}
	}
`);
const AdvanceClockDoc = graphql(`
	mutation AdvanceClock($toMillis: Float!) {
		advanceClock(input: { toMillis: $toMillis }) {
			ok
			command
			message
		}
	}
`);
const RestoreSnapshotDoc = graphql(`
	mutation RestoreSnapshot($id: String!) {
		restoreSnapshot(input: { id: $id }) {
			ok
			detail
		}
	}
`);
const DeleteSnapshotDoc = graphql(`
	mutation DeleteSnapshot($id: String!) {
		deleteSnapshot(input: { id: $id }) {
			ok
			detail
		}
	}
`);
const MintDoc = graphql(`
	mutation Mint($coinType: String!, $recipient: String!, $amountBaseUnits: String!) {
		mint(input: { coinType: $coinType, recipient: $recipient, amountBaseUnits: $amountBaseUnits }) {
			ok
			detail
			digest
		}
	}
`);
const FundDoc = graphql(`
	mutation Fund($recipient: String!, $coinType: String, $amountBaseUnits: String) {
		fund(input: { recipient: $recipient, coinType: $coinType, amountBaseUnits: $amountBaseUnits }) {
			ok
			detail
			digest
		}
	}
`);

/** Wipe all stack state (destructive). */
export const wipeStack = (endpoint: string): Promise<CommandResult> =>
	execute(endpoint, WipeDoc).then((d) => d.wipe);

/** Prune stale/unreferenced state. */
export const pruneStack = (endpoint: string): Promise<CommandResult> =>
	execute(endpoint, PruneDoc).then((d) => d.prune);

/** Shut the stack down. */
export const shutdownStack = (endpoint: string): Promise<CommandResult> =>
	execute(endpoint, ShutdownDoc).then((d) => d.shutdown);

/** Advance the on-chain clock to an absolute epoch-millis timestamp. */
export const advanceClock = (endpoint: string, toMillis: number): Promise<CommandResult> =>
	execute(endpoint, AdvanceClockDoc, { toMillis }).then((d) => d.advanceClock);

/** Restore a snapshot by id (real result, not fire-and-forget). */
export const restoreSnapshot = (endpoint: string, id: string): Promise<SnapshotActionResult> =>
	execute(endpoint, RestoreSnapshotDoc, { id }).then((d) => d.restoreSnapshot);

/** Delete a snapshot by id. */
export const deleteSnapshot = (endpoint: string, id: string): Promise<SnapshotActionResult> =>
	execute(endpoint, DeleteSnapshotDoc, { id }).then((d) => d.deleteSnapshot);

/**
 * Mint a coin to a recipient. `amountBaseUnits` is already scaled by the coin's
 * decimals (a base-unit integer string). Real on-chain execution: returns
 * `ok:false` + a `detail` reason for built-ins / coins without a treasury cap.
 */
export const mintCoin = (endpoint: string, args: MintArgs): Promise<MintResult> =>
	execute(endpoint, MintDoc, args).then((d) => d.mint);

/**
 * Fund an account/address through devstack's in-process funding strategies.
 * SUI (`coinType` absent / canonical) is a fixed-amount faucet grant (the
 * amount is ignored); WAL/DEEP route through an account-signed swap (the
 * amount is honored and the recipient must be a resolved account). Returns
 * the real processed result — `ok` + `detail` (digest is always null since
 * the strategies don't surface one).
 */
export const fundAccount = (endpoint: string, args: FundArgs): Promise<FundResult> =>
	execute(endpoint, FundDoc, {
		recipient: args.recipient,
		coinType: args.coinType ?? null,
		amountBaseUnits: args.amountBaseUnits ?? null,
	}).then((d) => d.fund);

// --- Observability: logs + spans --------------------------------------------

/** Filter for the cross-service log query (`LogFilter`). */
export interface LogQueryFilter {
	readonly services?: ReadonlyArray<string>;
	readonly levels?: ReadonlyArray<string>;
	readonly search?: string;
	readonly sinceMillis?: number;
	readonly limit?: number;
}

/** Filter for the completed-span query (`SpanFilter`). */
export interface SpanQueryFilter {
	readonly services?: ReadonlyArray<string>;
	readonly statuses?: ReadonlyArray<string>;
	readonly search?: string;
	readonly sinceMillis?: number;
	readonly limit?: number;
}

/** One cross-service log record, with `fields` parsed from the wire JSON string. */
export interface LogRecord {
	readonly seq: number;
	readonly timestampMillis: number;
	readonly level: string;
	readonly service: string;
	readonly message: string;
	/** Structured fields, parsed from `fieldsJson` (empty object on parse failure). */
	readonly fields: Record<string, unknown>;
}

/** One completed span, with `attributes` parsed from the wire JSON string. */
export interface SpanRecord {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentId: string | null;
	readonly name: string;
	readonly service: string | null;
	readonly startMillis: number;
	readonly durationMillis: number;
	readonly status: string;
	/** Span attributes, parsed from `attributesJson` (empty object on failure). */
	readonly attributes: Record<string, unknown>;
}

// The gql.tada-generated variable types want *mutable* `string[]` for the
// list filter fields, but the public `LogQueryFilter`/`SpanQueryFilter` expose
// `readonly` arrays (callers shouldn't mutate them). Project a readonly filter
// onto the mutable wire shape by spreading each array.
const logFilterToWire = (filter: LogQueryFilter) => ({
	sinceMillis: filter.sinceMillis,
	search: filter.search,
	limit: filter.limit,
	services: filter.services ? [...filter.services] : undefined,
	levels: filter.levels ? [...filter.levels] : undefined,
});

const spanFilterToWire = (filter: SpanQueryFilter) => ({
	sinceMillis: filter.sinceMillis,
	search: filter.search,
	limit: filter.limit,
	services: filter.services ? [...filter.services] : undefined,
	statuses: filter.statuses ? [...filter.statuses] : undefined,
});

const parseJsonObject = (raw: string): Record<string, unknown> => {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

const LogsDoc = graphql(`
	query Logs($filter: LogFilter) {
		logs(filter: $filter) {
			seq
			timestampMillis
			level
			service
			message
			fieldsJson
		}
	}
`);
const LogServicesDoc = graphql(`
	query LogServices {
		logServices
	}
`);
const SpansDoc = graphql(`
	query Spans($filter: SpanFilter) {
		spans(filter: $filter) {
			traceId
			spanId
			parentId
			name
			service
			startMillis
			durationMillis
			status
			attributesJson
		}
	}
`);
const SpanServicesDoc = graphql(`
	query SpanServices {
		spanServices
	}
`);

/** Query cross-service logs, parsing each record's `fieldsJson`. */
export const fetchLogs = async (
	endpoint: string,
	filter?: LogQueryFilter,
): Promise<LogRecord[]> => {
	const { logs } = await execute(endpoint, LogsDoc, {
		filter: filter ? logFilterToWire(filter) : null,
	});
	return logs.map((l) => ({
		seq: l.seq,
		timestampMillis: l.timestampMillis,
		level: l.level,
		service: l.service,
		message: l.message,
		fields: parseJsonObject(l.fieldsJson),
	}));
};

/** Distinct services that have emitted logs (for filter chips). */
export const fetchLogServices = (endpoint: string): Promise<ReadonlyArray<string>> =>
	execute(endpoint, LogServicesDoc).then((d) => d.logServices);

/** Query completed spans, parsing each record's `attributesJson`. */
export const fetchSpans = async (
	endpoint: string,
	filter?: SpanQueryFilter,
): Promise<SpanRecord[]> => {
	const { spans } = await execute(endpoint, SpansDoc, {
		filter: filter ? spanFilterToWire(filter) : null,
	});
	return spans.map((s) => ({
		traceId: s.traceId,
		spanId: s.spanId,
		parentId: s.parentId,
		name: s.name,
		service: s.service,
		startMillis: s.startMillis,
		durationMillis: s.durationMillis,
		status: s.status,
		attributes: parseJsonObject(s.attributesJson),
	}));
};

/** Distinct services that have recorded spans (for filter chips). */
export const fetchSpanServices = (endpoint: string): Promise<ReadonlyArray<string>> =>
	execute(endpoint, SpanServicesDoc).then((d) => d.spanServices);

// --- Domain queries ---------------------------------------------------------

const SnapshotsDoc = graphql(`
	query Snapshots {
		snapshots {
			id
			label
			app
			stack
			network
			createdAt
			containerCount
			subtreeCount
			participants
			corrupt
		}
	}
`);
const ModeDoc = graphql(`
	query Mode {
		mode
	}
`);
const DeepbookInfoDoc = graphql(`
	query DeepbookInfo {
		deepbookInfo {
			pluginKey
			name
			chain
			mode
			packageId
			registryId
			adminCapId
			deepTreasuryId
			indexerUrl
			serverUrl
			marketMakerRunning
			pools {
				poolId
				name
				baseCoinType
				quoteCoinType
			}
		}
	}
`);
const SealInfoDoc = graphql(`
	query SealInfo {
		sealInfo {
			pluginKey
			objectId
			mode
			threshold
			keyServerUrl
			keyServers {
				objectId
				weight
			}
		}
	}
`);
const CoinCapsDoc = graphql(`
	query CoinCaps {
		coinCaps {
			pluginKey
			source
			symbol
			decimals
			fullCoinType
			packageId
			treasuryCapId
		}
	}
`);
const FundableCoinsDoc = graphql(`
	query FundableCoins {
		fundableCoins {
			symbol
			coinType
			honorsAmount
			requiresAccountSigner
		}
	}
`);
const PostgresStatsDoc = graphql(`
	query PostgresStats {
		postgresStats {
			pluginKey
			available
			database
			plainUrl
			databaseBytes
			connectionCount
			detail
			tables {
				schema
				name
				rowEstimate
				totalBytes
			}
		}
	}
`);

/** Snapshot catalog entries (orchestrator `list`). */
export type SnapshotEntry = ResultOf<typeof SnapshotsDoc>['snapshots'][number];
/** A DeepBook deployment + its pools. */
export type DeepbookInfo = ResultOf<typeof DeepbookInfoDoc>['deepbookInfo'][number];
/** A Seal key-server deployment. */
export type SealInfo = ResultOf<typeof SealInfoDoc>['sealInfo'][number];
/** A coin treasury-cap entry. */
export type CoinCap = ResultOf<typeof CoinCapsDoc>['coinCaps'][number];
/** A coin the faucet can fund right now (drives the Faucet panel). */
export type FundableCoin = ResultOf<typeof FundableCoinsDoc>['fundableCoins'][number];
/** Postgres wire-protocol stats for one plugin instance. */
export type PostgresStats = ResultOf<typeof PostgresStatsDoc>['postgresStats'][number];
/** Resolved stack mode (`local` | `fork` | `live`), or null when unset. */
export type StackMode = ResultOf<typeof ModeDoc>['mode'];

/** Snapshot catalog. */
export const fetchSnapshots = (endpoint: string): Promise<ReadonlyArray<SnapshotEntry>> =>
	execute(endpoint, SnapshotsDoc).then((d) => d.snapshots);

/** Resolved stack mode. */
export const fetchMode = (endpoint: string): Promise<StackMode> =>
	execute(endpoint, ModeDoc).then((d) => d.mode);

/** DeepBook deployments + pools. */
export const fetchDeepbookInfo = (endpoint: string): Promise<ReadonlyArray<DeepbookInfo>> =>
	execute(endpoint, DeepbookInfoDoc).then((d) => d.deepbookInfo);

/** Seal key-server deployments. */
export const fetchSealInfo = (endpoint: string): Promise<ReadonlyArray<SealInfo>> =>
	execute(endpoint, SealInfoDoc).then((d) => d.sealInfo);

/** Coin treasury-cap registry. */
export const fetchCoinCaps = (endpoint: string): Promise<ReadonlyArray<CoinCap>> =>
	execute(endpoint, CoinCapsDoc).then((d) => d.coinCaps);

/** Coins the faucet can actually fund right now (SUI always; WAL/DEEP when
 *  their plugin registered a funding strategy). */
export const fetchFundableCoins = (endpoint: string): Promise<ReadonlyArray<FundableCoin>> =>
	execute(endpoint, FundableCoinsDoc).then((d) => d.fundableCoins);

/** Postgres stats per plugin instance. */
export const fetchPostgresStats = (endpoint: string): Promise<ReadonlyArray<PostgresStats>> =>
	execute(endpoint, PostgresStatsDoc).then((d) => d.postgresStats);

// Chain reads are NOT proxied through this control-plane API — the browser
// queries the Sui node directly over gRPC (`client.core.*`); see `lib/chain.ts`.
