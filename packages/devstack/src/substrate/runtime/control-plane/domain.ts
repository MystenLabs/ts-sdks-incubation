// Control-plane domain builder.
//
// Assembles the `ControlPlaneDomain` accessor surface from the data the
// supervisor holds at wiring time: the resolved plugin registry + graph,
// the (optional) snapshot orchestrator, the (optional) container runtime
// + filesystem (for Postgres exec-probing and snapshot catalog reads),
// and the stack identity.
//
// Design discipline:
//   - The projection (`SubscribableState`) is CLOSED — none of this data
//     touches it. We read resolved plugin VALUES via `readResolvedSync`,
//     the same name-blind seam `runtime-composition.ts` uses for the
//     manifest-extras lookup. The supervisor stays unaware of plugin
//     domain types; this module owns the structural projections.
//   - Every accessor degrades to empty/`null` rather than failing, so a
//     single missing/uninitialised plugin can't take down a dashboard
//     query (`E = never` on the public surface).
//   - We match plugins by resource-id PREFIX (`deepbook/`, `seal:`,
//     `coin:`, `postgres`) rather than plugin-key substrings — the
//     resource id is the stable identity the plugin factories mint.

import { Context, Effect, FileSystem } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { ResolvedGraph } from '../lifecycle/index.ts';
import { readResolvedSync, type PluginRegistry } from '../lifecycle/plugin-registry.ts';
import type { Identity } from '../../identity.ts';
import type { ContainerRuntime } from '../../../contracts/container-runtime.ts';
// Cross-layer seam (intentional): the control-plane domain is the single
// place the substrate reads the L3 snapshot orchestrator + the L1 docker
// runtime tags, so the supervisor core stays free of those imports. These
// are runtime VALUE imports (the `Context.Key` tags) — confined here.
import { ContainerRuntimeService } from '../../../runtime/docker/service.ts';
import {
	SnapshotOrchestratorService,
	type SnapshotOrchestrator,
} from '../../../orchestrators/snapshot/service.ts';
import type {
	ControlPlaneCoinCap,
	ControlPlaneDeepbookInfo,
	ControlPlaneDomain,
	ControlPlaneMintResult,
	ControlPlanePostgresStats,
	ControlPlanePostgresTable,
	ControlPlaneSealInfo,
	ControlPlaneSnapshotEntry,
} from './service.ts';
import type { LogStoreShape, SpanStoreShape } from '../observability/index.ts';

// -----------------------------------------------------------------------------
// Structural projections of plugin-resolved values
//
// We import NO plugin types — the plugins live above the substrate in the
// layering. Instead we narrow the opaque `unknown` resolved value through
// shallow structural shapes that mirror the relevant fields. A field
// missing on the live value collapses to the null/empty default.
// -----------------------------------------------------------------------------

interface DeepbookShape {
	readonly mode?: unknown;
	readonly chain?: unknown;
	readonly packageId?: unknown;
	readonly registryId?: unknown;
	readonly adminCapId?: unknown;
	readonly deepTreasuryId?: unknown;
	readonly pools?: ReadonlyArray<{
		readonly name?: unknown;
		readonly poolId?: unknown;
		readonly baseCoinType?: unknown;
		readonly quoteCoinType?: unknown;
	}>;
	readonly marketMakerRunning?: unknown;
	readonly serverUrl?: unknown;
	readonly indexerUrl?: unknown;
}

interface SealShape {
	readonly mode?: unknown;
	readonly objectId?: unknown;
	readonly keyServerUrl?: unknown;
	readonly serverConfigs?: ReadonlyArray<{ readonly objectId?: unknown; readonly weight?: unknown }>;
}

interface CoinShape {
	readonly symbol?: unknown;
	readonly fullCoinType?: unknown;
	readonly decimals?: unknown;
	readonly source?: unknown;
	readonly treasuryCapId?: unknown;
	readonly packageId?: unknown;
	/** Self-contained mint closure on the resolved coin value (present
	 *  for witness-form coins whose publisher still owns the cap). Read
	 *  structurally — the substrate imports no coin types. Returns an
	 *  Effect that resolves a `{ digest }`-bearing result or fails with a
	 *  coin/artifact-publisher tagged error. */
	readonly mintFromCap?: (opts: {
		readonly to: string;
		readonly amount: bigint;
	}) => Effect.Effect<{ readonly digest: string }, { readonly message?: unknown }>;
}

interface PostgresShape {
	readonly name?: unknown;
	readonly user?: unknown;
	readonly databases?: ReadonlyArray<unknown>;
	readonly plainEndpoint?: unknown;
	readonly networkAlias?: unknown;
	readonly port?: unknown;
}

interface SuiShape {
	readonly mode?: unknown;
}

/** A 0x-prefixed Sui address: `0x` + 1..64 hex digits. Mirrors the
 *  address validation the mint PTB's `tx.pure.address` ultimately
 *  enforces, surfaced up front so the dashboard gets a clean rejection
 *  rather than an opaque build failure. */
const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

/** A positive integer base-unit amount string (no sign, no decimal
 *  point, no leading zeros beyond a bare `0` — which is itself rejected
 *  as non-positive). */
const isPositiveIntegerString = (s: string): boolean => {
	if (!/^\d+$/.test(s)) return false;
	try {
		return BigInt(s) > 0n;
	} catch {
		return false;
	}
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strReq = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;

/** Iterate every resolved plugin value whose resource id matches a
 *  predicate, in graph order. Returns `[pluginKey, value]` tuples. */
const resolvedMatching = (
	graph: ResolvedGraph,
	registry: PluginRegistry,
	matches: (resourceId: string) => boolean,
): ReadonlyArray<readonly [PluginKey, unknown]> => {
	const out: Array<readonly [PluginKey, unknown]> = [];
	for (const [key, node] of graph.nodes) {
		if (!matches(node.member.id)) continue;
		const value = readResolvedSync(registry, key);
		if (value === undefined || value === null) continue;
		out.push([key, value] as const);
	}
	return out;
};

// -----------------------------------------------------------------------------
// Postgres wire-protocol stats via `psql` exec inside the container
// -----------------------------------------------------------------------------

/** SQL that emits a single line of JSON the dashboard can parse without a
 *  PG client. Keeps the round trip to one exec. */
const PG_STATS_SQL = `SELECT json_build_object(
  'db_bytes', pg_database_size(current_database()),
  'connections', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
  'tables', COALESCE((
    SELECT json_agg(t) FROM (
      SELECT schemaname AS schema, relname AS name,
             n_live_tup AS row_estimate,
             pg_total_relation_size(relid) AS total_bytes
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 200
    ) t
  ), '[]'::json)
)`;

const parsePgStats = (
	pluginKey: PluginKey,
	pg: PostgresShape,
	stdout: string,
): ControlPlanePostgresStats => {
	const database = strReq((pg.databases ?? [])[0]) || 'postgres';
	const host = str(pg.networkAlias) ?? 'postgres';
	const port = num(pg.port) ?? 5432;
	const plainUrl = `postgres://${host}:${port}`;
	const base = {
		pluginKey: String(pluginKey),
		database,
		plainUrl,
	} as const;
	try {
		const trimmed = stdout.trim();
		const parsed = JSON.parse(trimmed) as {
			db_bytes?: number;
			connections?: number;
			tables?: ReadonlyArray<{
				schema?: string;
				name?: string;
				row_estimate?: number;
				total_bytes?: number;
			}>;
		};
		const tables: ControlPlanePostgresTable[] = (parsed.tables ?? []).map((t) => ({
			schema: t.schema ?? 'public',
			name: t.name ?? '',
			rowEstimate: num(t.row_estimate) ?? 0,
			totalBytes: num(t.total_bytes) ?? 0,
		}));
		return {
			...base,
			databaseBytes: num(parsed.db_bytes) ?? 0,
			connectionCount: num(parsed.connections) ?? 0,
			tables,
			available: true,
			detail: null,
		};
	} catch (cause) {
		return {
			...base,
			databaseBytes: 0,
			connectionCount: 0,
			tables: [],
			available: false,
			detail: `failed to parse psql output: ${String(cause)}`,
		};
	}
};

const unavailablePgStats = (
	pluginKey: PluginKey,
	pg: PostgresShape,
	detail: string,
): ControlPlanePostgresStats => {
	const database = strReq((pg.databases ?? [])[0]) || 'postgres';
	const host = str(pg.networkAlias) ?? 'postgres';
	const port = num(pg.port) ?? 5432;
	return {
		pluginKey: String(pluginKey),
		database,
		plainUrl: `postgres://${host}:${port}`,
		databaseBytes: 0,
		connectionCount: 0,
		tables: [],
		available: false,
		detail,
	};
};

// -----------------------------------------------------------------------------
// Snapshot catalog projection
// -----------------------------------------------------------------------------

const snapshotEntryFrom = (entry: {
	readonly id: string;
	readonly metadata: {
		readonly label?: string | null;
		readonly createdAt?: number;
		readonly app?: string;
		readonly stack?: string;
		readonly network?: string;
		readonly participants?: ReadonlyArray<string>;
		readonly containers?: ReadonlyArray<unknown>;
		readonly subtrees?: ReadonlyArray<unknown>;
	} | null;
}): ControlPlaneSnapshotEntry => {
	const m = entry.metadata;
	return {
		id: entry.id,
		label: m?.label ?? null,
		createdAt: m?.createdAt ?? null,
		app: m?.app ?? null,
		stack: m?.stack ?? null,
		network: m?.network ?? null,
		participants: m?.participants ?? [],
		containerCount: m?.containers?.length ?? 0,
		subtreeCount: m?.subtrees?.length ?? 0,
		corrupt: m === null,
	};
};

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export interface ControlPlaneDomainDeps {
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly identity: Identity;
	/** Optional — present in production wiring (CLI / runStack), absent in
	 *  bare smoke tests. Snapshot accessors degrade to empty when missing. */
	readonly snapshotOrchestrator: SnapshotOrchestrator | null;
	/** Optional container runtime for Postgres exec-probing. */
	readonly containerRuntime: ContainerRuntime | null;
	/** Optional filesystem (snapshot orchestrator effects require it). */
	readonly fileSystem: FileSystem.FileSystem | null;
	/** Optional cross-service log store. Absent in bare smoke-test paths;
	 *  the `logs`/`logServices` accessors degrade to empty when null. */
	readonly logStore: LogStoreShape | null;
	/** Optional completed-span store. Absent in bare smoke-test paths; the
	 *  `spans`/`spanServices` accessors degrade to empty when null. */
	readonly spanStore: SpanStoreShape | null;
}

export const buildControlPlaneDomain = (deps: ControlPlaneDomainDeps): ControlPlaneDomain => {
	const {
		graph,
		registry,
		identity,
		snapshotOrchestrator,
		containerRuntime,
		fileSystem,
		logStore,
		spanStore,
	} = deps;

	const provideFs = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem>): Effect.Effect<A, E> =>
		fileSystem === null
			? (Effect.die('control-plane: FileSystem unavailable') as Effect.Effect<A, E>)
			: Effect.provideService(eff, FileSystem.FileSystem, fileSystem);

	const mode: ControlPlaneDomain['mode'] = Effect.sync(() => {
		const sui = resolvedMatching(graph, registry, (id) => id === 'sui')[0];
		if (sui === undefined) return null;
		const m = (sui[1] as SuiShape).mode;
		switch (m) {
			case 'fork':
				return 'fork';
			case 'live':
				return 'live';
			case 'local':
			case 'local-rpc':
				return 'local';
			default:
				return null;
		}
	});

	const snapshots: ControlPlaneDomain['snapshots'] =
		snapshotOrchestrator === null
			? Effect.succeed([])
			: provideFs(snapshotOrchestrator.list).pipe(
					Effect.map((entries) => entries.map(snapshotEntryFrom)),
					Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ControlPlaneSnapshotEntry>)),
				);

	const restoreSnapshot: ControlPlaneDomain['restoreSnapshot'] = (id) =>
		snapshotOrchestrator === null
			? Effect.succeed({ ok: false, detail: 'snapshot orchestrator unavailable' as string | null })
			: provideFs(snapshotOrchestrator.restore({ id })).pipe(
					Effect.map(() => ({ ok: true, detail: null as string | null })),
					Effect.catchCause((cause) =>
						Effect.succeed({ ok: false, detail: String(cause) as string | null }),
					),
				);

	const deleteSnapshot: ControlPlaneDomain['deleteSnapshot'] = (id) =>
		snapshotOrchestrator === null
			? Effect.succeed({ ok: false, detail: 'snapshot orchestrator unavailable' as string | null })
			: provideFs(snapshotOrchestrator.delete(id)).pipe(
					Effect.map(() => ({ ok: true, detail: null as string | null })),
					Effect.catchCause((cause) =>
						Effect.succeed({ ok: false, detail: String(cause) as string | null }),
					),
				);

	const deepbook: ControlPlaneDomain['deepbook'] = Effect.sync(() =>
		resolvedMatching(graph, registry, (id) => id.startsWith('deepbook/')).map(
			([key, value]): ControlPlaneDeepbookInfo => {
				const v = value as DeepbookShape;
				const modeRaw = v.mode;
				const dbMode =
					modeRaw === 'override' ? 'override' : modeRaw === 'known' ? 'known' : 'local';
				return {
					pluginKey: String(key),
					name: String(key).replace(/^deepbook:/, ''),
					mode: dbMode,
					chain: strReq(v.chain),
					packageId: strReq(v.packageId),
					registryId: strReq(v.registryId),
					adminCapId: str(v.adminCapId),
					deepTreasuryId: str(v.deepTreasuryId),
					pools: (v.pools ?? []).map((p) => ({
						name: strReq(p.name),
						poolId: strReq(p.poolId),
						baseCoinType: strReq(p.baseCoinType),
						quoteCoinType: strReq(p.quoteCoinType),
					})),
					marketMakerRunning: bool(v.marketMakerRunning),
					serverUrl: str(v.serverUrl),
					indexerUrl: str(v.indexerUrl),
				};
			},
		),
	);

	const seal: ControlPlaneDomain['seal'] = Effect.sync(() =>
		resolvedMatching(graph, registry, (id) => id.startsWith('seal:')).map(
			([key, value]): ControlPlaneSealInfo => {
				const v = value as SealShape;
				const sealMode =
					v.mode === 'live' ? 'live' : v.mode === 'fork-known' ? 'fork-known' : 'local-keygen';
				const keyServers = (v.serverConfigs ?? []).map((c) => ({
					objectId: strReq(c.objectId),
					weight: num(c.weight) ?? 1,
				}));
				return {
					pluginKey: String(key),
					mode: sealMode,
					objectId: strReq(v.objectId),
					keyServerUrl: strReq(v.keyServerUrl),
					keyServers,
					threshold: keyServers.length,
				};
			},
		),
	);

	const coinCaps: ControlPlaneDomain['coinCaps'] = Effect.sync(() =>
		resolvedMatching(graph, registry, (id) => id.startsWith('coin:')).map(
			([key, value]): ControlPlaneCoinCap => {
				const v = value as CoinShape;
				const source =
					v.source === 'registry'
						? 'registry'
						: v.source === 'builtin'
							? 'builtin'
							: 'on-chain';
				return {
					pluginKey: String(key),
					symbol: str(v.symbol),
					fullCoinType: strReq(v.fullCoinType),
					decimals: num(v.decimals) ?? 0,
					source,
					treasuryCapId: str(v.treasuryCapId),
					packageId: str(v.packageId),
				};
			},
		),
	);

	// Mint ACTION — drives the dashboard Coins panel's Mint button.
	//
	// Signer source: the resolved coin VALUE carries a self-contained
	// `mintFromCap` closure (present only for witness-form coins whose
	// publisher still owns the TreasuryCap). That closure already captures
	// the treasury-cap-owning publisher `MintSigner` + the resolved cap id
	// in-process — the same lease-owning path `coin/service.ts`'s
	// `fundingStrategy` uses — so the control plane mints WITHOUT threading
	// a signer through this seam (the projection stays closed; we read the
	// resolved value, never plugin internals).
	//
	// Never fails (`E = never`): every reject path (bad address, non-
	// positive amount, no matching coin, cap-not-owned, on-chain failure)
	// degrades to `{ ok: false, detail, digest: null }` so the dashboard
	// query can't be taken down by a single bad mint.
	const mintCoin: ControlPlaneDomain['mintCoin'] = (input) =>
		Effect.gen(function* () {
			const recipient = input.recipient.trim();
			if (!SUI_ADDRESS_RE.test(recipient)) {
				return {
					ok: false,
					detail: `invalid recipient '${input.recipient}': expected a 0x-prefixed Sui address`,
					digest: null,
				} satisfies ControlPlaneMintResult;
			}
			if (!isPositiveIntegerString(input.amountBaseUnits)) {
				return {
					ok: false,
					detail: `invalid amountBaseUnits '${input.amountBaseUnits}': expected a positive integer string`,
					digest: null,
				} satisfies ControlPlaneMintResult;
			}

			// Locate the resolved coin whose fullCoinType matches. Match on the
			// resolved value's `fullCoinType` (the stable on-chain type), not the
			// resource-id prefix, so callers pass the same `coinType` the
			// `coinCaps` query surfaced.
			const match = resolvedMatching(graph, registry, (id) => id.startsWith('coin:'))
				.map(([, value]) => value as CoinShape)
				.find((v) => strReq(v.fullCoinType) === input.coinType);

			if (match === undefined) {
				return {
					ok: false,
					detail: `no resolved coin found for type '${input.coinType}'`,
					digest: null,
				} satisfies ControlPlaneMintResult;
			}
			if (typeof match.mintFromCap !== 'function') {
				return {
					ok: false,
					detail:
						`coin '${input.coinType}' has no in-process treasury cap signer — ` +
						'mint is only available for local-package coins whose publisher still owns the TreasuryCap',
					digest: null,
				} satisfies ControlPlaneMintResult;
			}

			return yield* match
				.mintFromCap({ to: recipient, amount: BigInt(input.amountBaseUnits) })
				.pipe(
					Effect.map(
						(r): ControlPlaneMintResult => ({
							ok: true,
							detail: `minted ${input.amountBaseUnits} of ${input.coinType} to ${recipient}`,
							digest: r.digest,
						}),
					),
					// Typed coin/artifact-publisher failures carry `.message`.
					Effect.catch((cause) =>
						Effect.succeed<ControlPlaneMintResult>({
							ok: false,
							detail:
								typeof cause?.message === 'string'
									? cause.message
									: `mint failed: ${String(cause)}`,
							digest: null,
						}),
					),
					// Residual defects (interrupts, unexpected throws) — degrade
					// rather than crash the dashboard query.
					Effect.catchCause((cause) =>
						Effect.succeed<ControlPlaneMintResult>({
							ok: false,
							detail: `mint crashed: ${String(cause)}`,
							digest: null,
						}),
					),
				);
		});

	const postgresStats: ControlPlaneDomain['postgresStats'] = Effect.gen(function* () {
		const instances = resolvedMatching(graph, registry, (id) => id === 'postgres' || id.startsWith('postgres'));
		if (instances.length === 0) return [];
		const out: ControlPlanePostgresStats[] = [];
		for (const [key, value] of instances) {
			const pg = value as PostgresShape;
			if (containerRuntime === null) {
				out.push(unavailablePgStats(key, pg, 'container runtime unavailable'));
				continue;
			}
			const database = strReq((pg.databases ?? [])[0]) || 'postgres';
			const pgUser = str(pg.user) ?? 'postgres';
			const role = str(pg.name) ?? 'postgres';
			const probe = Effect.gen(function* () {
				const handles = yield* containerRuntime.inspectByLabels({
					app: String(identity.app),
					stack: String(identity.stack),
					plugin: 'postgres',
					role,
				});
				const running = handles.find((h) => h.status === 'running') ?? handles[0];
				if (running === undefined) {
					return unavailablePgStats(key, pg, 'no running postgres container found');
				}
				const result = yield* containerRuntime.exec(running, [
					'psql',
					'-U',
					pgUser,
					'-d',
					database,
					'-tAc',
					PG_STATS_SQL,
				]);
				if (result.exitCode !== 0) {
					return unavailablePgStats(
						key,
						pg,
						`psql exited ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`,
					);
				}
				return parsePgStats(key, pg, result.stdout);
			});
			const stats = yield* probe.pipe(
				Effect.catchCause((cause) => Effect.succeed(unavailablePgStats(key, pg, String(cause)))),
			);
			out.push(stats);
		}
		return out;
	});

	// Observability accessors. These read the process-scoped stores the
	// supervisor created (fed off the same Logger path as the projection
	// tail / the recording Tracer). Filtering happens server-side in the
	// store; the dashboard never pulls the whole ring across the wire.
	// Each degrades to empty when the corresponding store is absent.
	const logs: ControlPlaneDomain['logs'] = (filter) =>
		logStore === null ? Effect.succeed([]) : logStore.query(filter);

	const logServices: ControlPlaneDomain['logServices'] =
		logStore === null ? Effect.succeed([]) : logStore.services;

	const spans: ControlPlaneDomain['spans'] = (filter) =>
		spanStore === null ? Effect.succeed([]) : spanStore.query(filter);

	const spanServices: ControlPlaneDomain['spanServices'] =
		spanStore === null ? Effect.succeed([]) : spanStore.services;

	return {
		mode,
		snapshots,
		restoreSnapshot,
		deleteSnapshot,
		deepbook,
		seal,
		coinCaps,
		mintCoin,
		postgresStats,
		logs,
		logServices,
		spans,
		spanServices,
	};
};

/** An all-empty domain surface. Used by bare smoke-test paths and the
 *  dashboard server tests that exercise the projection/command plane
 *  without a live registry. Every accessor resolves to empty/`null`. */
export const emptyControlPlaneDomain: ControlPlaneDomain = {
	mode: Effect.succeed(null),
	snapshots: Effect.succeed([]),
	restoreSnapshot: () => Effect.succeed({ ok: false, detail: 'unavailable' }),
	deleteSnapshot: () => Effect.succeed({ ok: false, detail: 'unavailable' }),
	deepbook: Effect.succeed([]),
	seal: Effect.succeed([]),
	coinCaps: Effect.succeed([]),
	mintCoin: () => Effect.succeed({ ok: false, detail: 'unavailable', digest: null }),
	postgresStats: Effect.succeed([]),
	logs: () => Effect.succeed([]),
	logServices: Effect.succeed([]),
	spans: () => Effect.succeed([]),
	spanServices: Effect.succeed([]),
};

/** Read an optional service value out of a `Context.Context<never>`,
 *  returning `null` when absent. */
const readOptional = <S, I>(ctx: Context.Context<never>, tag: Context.Key<I, S>): S | null => {
	const opt = Context.getOption(ctx as Context.Context<I>, tag);
	return opt._tag === 'Some' ? opt.value : null;
};

/** Build the control-plane domain by reading the optional snapshot
 *  orchestrator / container runtime / filesystem services out of the
 *  supervisor's `pluginContext`. The supervisor calls THIS (not
 *  `buildControlPlaneDomain` directly) so the L3/L1 service tags stay
 *  imported only inside the control-plane seam, never in the supervisor
 *  core. Each is optional: bare smoke-test `supervise()` paths don't
 *  layer them, so the corresponding accessors degrade to empty. */
export const controlPlaneDomainFromContext = (args: {
	readonly pluginContext: Context.Context<never>;
	readonly graph: ResolvedGraph;
	readonly registry: PluginRegistry;
	readonly identity: Identity;
	/** The supervisor's process-scoped log store, passed directly (it is
	 *  created in the supervisor closure, not layered into `pluginContext`).
	 *  `null` in bare smoke-test paths that don't build one. */
	readonly logStore?: LogStoreShape | null;
	/** The supervisor's process-scoped span store, passed directly. `null`
	 *  in bare smoke-test paths. */
	readonly spanStore?: SpanStoreShape | null;
}): ControlPlaneDomain =>
	buildControlPlaneDomain({
		graph: args.graph,
		registry: args.registry,
		identity: args.identity,
		snapshotOrchestrator: readOptional(args.pluginContext, SnapshotOrchestratorService),
		containerRuntime: readOptional(args.pluginContext, ContainerRuntimeService),
		fileSystem: readOptional(args.pluginContext, FileSystem.FileSystem),
		logStore: args.logStore ?? null,
		spanStore: args.spanStore ?? null,
	});
