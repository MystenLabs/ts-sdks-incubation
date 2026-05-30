// Dashboard plugin-domain shaping.
//
// The substrate control-plane is GENERIC + name-blind: it hands out the
// snapshot catalog, the observability rings, and a single uninterpreted
// `resolvedValues` accessor (see `substrate/runtime/control-plane/`). This
// module — which lives in the PLUGIN layer and is allowed to name plugins —
// owns ALL plugin-name-aware shaping: it matches resolved plugin values by
// resource-id prefix (`deepbook/`, `seal:`, `coin:`, `id === 'sui'`,
// postgres-by-labels) and projects them into the app-agnostic shapes the
// GraphQL schema renders. It also owns the `mode` derivation, the coin
// `mint` action, and the Postgres `psql`-exec wire-protocol stats.
//
// Design discipline (mirrors the old substrate seam, one layer up):
//   - We import NO plugin types — we narrow the opaque `unknown` resolved
//     value through shallow structural shapes that mirror the relevant
//     fields. A field missing on the live value collapses to the
//     null/empty default.
//   - Every accessor degrades to empty/`null` rather than failing, so a
//     single missing/uninitialised plugin can't take down a dashboard
//     query (`E = never` on the public surface).
//   - We match plugins by resource-id PREFIX (`deepbook/`, `seal:`,
//     `coin:`, `postgres`) rather than plugin-key substrings — the
//     resource id is the stable identity the plugin factories mint.

import { Effect } from 'effect';

import type { ContainerRuntime } from '../../contracts/container-runtime.ts';
import type { Identity } from '../../substrate/identity.ts';
import type {
	ControlPlaneDomain,
	ControlPlaneResolvedValue,
} from '../../substrate/runtime/control-plane/service.ts';

// -----------------------------------------------------------------------------
// App-agnostic domain shapes the GraphQL schema renders.
// -----------------------------------------------------------------------------

/** One DeepBook pool object id + coin types (prices are chain-direct). */
export interface DashboardDeepbookPool {
	readonly name: string;
	readonly poolId: string;
	readonly baseCoinType: string;
	readonly quoteCoinType: string;
}

export interface DashboardDeepbookInfo {
	readonly pluginKey: string;
	readonly name: string;
	readonly mode: 'local' | 'override' | 'known';
	readonly chain: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly deepTreasuryId: string | null;
	readonly pools: ReadonlyArray<DashboardDeepbookPool>;
	readonly marketMakerRunning: boolean;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
}

export interface DashboardSealKeyServer {
	readonly objectId: string;
	readonly weight: number;
}

export interface DashboardSealInfo {
	readonly pluginKey: string;
	readonly mode: 'local-keygen' | 'live' | 'fork-known';
	readonly objectId: string;
	readonly keyServerUrl: string;
	readonly keyServers: ReadonlyArray<DashboardSealKeyServer>;
	/** Threshold = number of registered key-server configs. */
	readonly threshold: number;
}

/** A coin's treasury-cap id (drives the Mint action) + addressing facts. */
export interface DashboardCoinCap {
	readonly pluginKey: string;
	readonly symbol: string | null;
	readonly fullCoinType: string;
	readonly decimals: number;
	readonly source: 'registry' | 'on-chain' | 'builtin';
	readonly treasuryCapId: string | null;
	readonly packageId: string | null;
}

/** Input for the dashboard mint ACTION. `amountBaseUnits` is the raw
 *  integer amount in the coin's smallest unit (decimals already applied
 *  by the caller / form) — a string so large u64 values survive the wire
 *  without precision loss. */
export interface DashboardMintInput {
	readonly coinType: string;
	readonly recipient: string;
	readonly amountBaseUnits: string;
}

/** Outcome of a dashboard mint ACTION. Mirrors the snapshot
 *  restore/delete result shape plus the on-chain tx `digest` on success. */
export interface DashboardMintResult {
	readonly ok: boolean;
	readonly detail: string;
	readonly digest: string | null;
}

export interface DashboardPostgresTable {
	readonly schema: string;
	readonly name: string;
	readonly rowEstimate: number;
	readonly totalBytes: number;
}

export interface DashboardPostgresStats {
	readonly pluginKey: string;
	readonly database: string;
	/** Plain (password-less) DSN — the credentialed form NEVER leaves the
	 *  backend. */
	readonly plainUrl: string;
	readonly databaseBytes: number;
	readonly connectionCount: number;
	readonly tables: ReadonlyArray<DashboardPostgresTable>;
	/** `false` when stats could not be gathered (container down, exec
	 *  failure). The dashboard renders a degraded state rather than
	 *  failing the whole query. */
	readonly available: boolean;
	readonly detail: string | null;
}

/** The dashboard plugin-domain accessor surface. Each member is a
 *  self-contained Effect that never fails (`E = never`); they degrade to
 *  empty/`null` so a single missing plugin can't take down the dashboard
 *  query. */
export interface DashboardDomain {
	/** Fork-vs-local mode, derived from the resolved sui plugin's chain
	 *  identity. Used for advance-clock gating. `null` when no sui plugin
	 *  is present. */
	readonly mode: Effect.Effect<'fork' | 'local' | 'live' | null>;
	/** DeepBook deployments (registry/admin/pool ids + MM state). */
	readonly deepbook: Effect.Effect<ReadonlyArray<DashboardDeepbookInfo>>;
	/** Seal key-server deployments (objectId/threshold/mode). */
	readonly seal: Effect.Effect<ReadonlyArray<DashboardSealInfo>>;
	/** Coin treasury caps (drives Mint). */
	readonly coinCaps: Effect.Effect<ReadonlyArray<DashboardCoinCap>>;
	/** Postgres wire-protocol stats per postgres plugin instance. */
	readonly postgresStats: Effect.Effect<ReadonlyArray<DashboardPostgresStats>>;
	/** Mint ACTION — mints `amountBaseUnits` of `coinType` to `recipient`,
	 *  signed in-process by the treasury-cap-owning publisher signer the
	 *  resolved coin value's self-contained `mintFromCap` closure holds. */
	readonly mintCoin: (input: DashboardMintInput) => Effect.Effect<DashboardMintResult>;
}

// -----------------------------------------------------------------------------
// Structural projections of plugin-resolved values
//
// We narrow the opaque `unknown` resolved value through shallow structural
// shapes that mirror the relevant fields. A field missing on the live value
// collapses to the null/empty default.
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
	readonly serverConfigs?: ReadonlyArray<{
		readonly objectId?: unknown;
		readonly weight?: unknown;
	}>;
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
	 *  structurally — we import no coin types. Returns an Effect that
	 *  resolves a `{ digest }`-bearing result or fails with a
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

/** Filter the generic resolved values down to those whose resource id
 *  matches a predicate, in graph order. Returns the `{ pluginKey, value }`
 *  the shaping functions consume. */
const matching = (
	values: ReadonlyArray<ControlPlaneResolvedValue>,
	matches: (resourceId: string) => boolean,
): ReadonlyArray<ControlPlaneResolvedValue> => values.filter((v) => matches(v.id));

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
	pluginKey: string,
	pg: PostgresShape,
	stdout: string,
): DashboardPostgresStats => {
	const database = strReq((pg.databases ?? [])[0]) || 'postgres';
	const host = str(pg.networkAlias) ?? 'postgres';
	const port = num(pg.port) ?? 5432;
	const plainUrl = `postgres://${host}:${port}`;
	const base = {
		pluginKey,
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
		const tables: DashboardPostgresTable[] = (parsed.tables ?? []).map((t) => ({
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
	pluginKey: string,
	pg: PostgresShape,
	detail: string,
): DashboardPostgresStats => {
	const database = strReq((pg.databases ?? [])[0]) || 'postgres';
	const host = str(pg.networkAlias) ?? 'postgres';
	const port = num(pg.port) ?? 5432;
	return {
		pluginKey,
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
// Builder
// -----------------------------------------------------------------------------

export interface DashboardDomainDeps {
	/** The generic, name-blind control-plane domain (resolved values). */
	readonly control: ControlPlaneDomain;
	/** Stack identity, used for the postgres container label probe. */
	readonly identity: Identity;
	/** Container runtime for the Postgres `psql` exec-probe. `null` in bare
	 *  test paths; `postgresStats` degrades to an unavailable entry then. */
	readonly containerRuntime: ContainerRuntime | null;
}

export const buildDashboardDomain = (deps: DashboardDomainDeps): DashboardDomain => {
	const { control, identity, containerRuntime } = deps;

	const mode: DashboardDomain['mode'] = control.resolvedValues.pipe(
		Effect.map((values) => {
			const sui = matching(values, (id) => id === 'sui')[0];
			if (sui === undefined) return null;
			const m = (sui.value as SuiShape).mode;
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
		}),
	);

	const deepbook: DashboardDomain['deepbook'] = control.resolvedValues.pipe(
		Effect.map((values) =>
			matching(values, (id) => id.startsWith('deepbook/')).map(
				({ pluginKey, value }): DashboardDeepbookInfo => {
					const v = value as DeepbookShape;
					const modeRaw = v.mode;
					const dbMode =
						modeRaw === 'override' ? 'override' : modeRaw === 'known' ? 'known' : 'local';
					return {
						pluginKey,
						name: pluginKey.replace(/^deepbook:/, ''),
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
		),
	);

	const seal: DashboardDomain['seal'] = control.resolvedValues.pipe(
		Effect.map((values) =>
			matching(values, (id) => id.startsWith('seal:')).map(
				({ pluginKey, value }): DashboardSealInfo => {
					const v = value as SealShape;
					const sealMode =
						v.mode === 'live' ? 'live' : v.mode === 'fork-known' ? 'fork-known' : 'local-keygen';
					const keyServers = (v.serverConfigs ?? []).map((c) => ({
						objectId: strReq(c.objectId),
						weight: num(c.weight) ?? 1,
					}));
					return {
						pluginKey,
						mode: sealMode,
						objectId: strReq(v.objectId),
						keyServerUrl: strReq(v.keyServerUrl),
						keyServers,
						threshold: keyServers.length,
					};
				},
			),
		),
	);

	const coinCaps: DashboardDomain['coinCaps'] = control.resolvedValues.pipe(
		Effect.map((values) =>
			matching(values, (id) => id.startsWith('coin:')).map(
				({ pluginKey, value }): DashboardCoinCap => {
					const v = value as CoinShape;
					const source =
						v.source === 'registry' ? 'registry' : v.source === 'builtin' ? 'builtin' : 'on-chain';
					return {
						pluginKey,
						symbol: str(v.symbol),
						fullCoinType: strReq(v.fullCoinType),
						decimals: num(v.decimals) ?? 0,
						source,
						treasuryCapId: str(v.treasuryCapId),
						packageId: str(v.packageId),
					};
				},
			),
		),
	);

	// Mint ACTION — drives the dashboard Coins panel's Mint button.
	//
	// Signer source: the resolved coin VALUE carries a self-contained
	// `mintFromCap` closure (present only for witness-form coins whose
	// publisher still owns the TreasuryCap). That closure already captures
	// the treasury-cap-owning publisher `MintSigner` + the resolved cap id
	// in-process — the same lease-owning path `coin/service.ts`'s
	// `fundingStrategy` uses — so we mint WITHOUT threading a signer through
	// this seam (we read the resolved value, never plugin internals).
	//
	// Never fails (`E = never`): every reject path (bad address, non-
	// positive amount, no matching coin, cap-not-owned, on-chain failure)
	// degrades to `{ ok: false, detail, digest: null }` so the dashboard
	// query can't be taken down by a single bad mint.
	const mintCoin: DashboardDomain['mintCoin'] = (input) =>
		Effect.gen(function* () {
			const recipient = input.recipient.trim();
			if (!SUI_ADDRESS_RE.test(recipient)) {
				return {
					ok: false,
					detail: `invalid recipient '${input.recipient}': expected a 0x-prefixed Sui address`,
					digest: null,
				} satisfies DashboardMintResult;
			}
			if (!isPositiveIntegerString(input.amountBaseUnits)) {
				return {
					ok: false,
					detail: `invalid amountBaseUnits '${input.amountBaseUnits}': expected a positive integer string`,
					digest: null,
				} satisfies DashboardMintResult;
			}

			// Locate the resolved coin whose fullCoinType matches. Match on the
			// resolved value's `fullCoinType` (the stable on-chain type), not the
			// resource-id prefix, so callers pass the same `coinType` the
			// `coinCaps` query surfaced.
			const values = yield* control.resolvedValues;
			const match = matching(values, (id) => id.startsWith('coin:'))
				.map(({ value }) => value as CoinShape)
				.find((v) => strReq(v.fullCoinType) === input.coinType);

			if (match === undefined) {
				return {
					ok: false,
					detail: `no resolved coin found for type '${input.coinType}'`,
					digest: null,
				} satisfies DashboardMintResult;
			}
			if (typeof match.mintFromCap !== 'function') {
				return {
					ok: false,
					detail:
						`coin '${input.coinType}' has no in-process treasury cap signer — ` +
						'mint is only available for local-package coins whose publisher still owns the TreasuryCap',
					digest: null,
				} satisfies DashboardMintResult;
			}

			return yield* match
				.mintFromCap({ to: recipient, amount: BigInt(input.amountBaseUnits) })
				.pipe(
					Effect.map(
						(r): DashboardMintResult => ({
							ok: true,
							detail: `minted ${input.amountBaseUnits} of ${input.coinType} to ${recipient}`,
							digest: r.digest,
						}),
					),
					// Typed coin/artifact-publisher failures carry `.message`.
					Effect.catch((cause) =>
						Effect.succeed<DashboardMintResult>({
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
						Effect.succeed<DashboardMintResult>({
							ok: false,
							detail: `mint crashed: ${String(cause)}`,
							digest: null,
						}),
					),
				);
		});

	const postgresStats: DashboardDomain['postgresStats'] = Effect.gen(function* () {
		const values = yield* control.resolvedValues;
		const instances = matching(values, (id) => id === 'postgres');
		if (instances.length === 0) return [];
		const out: DashboardPostgresStats[] = [];
		for (const { pluginKey, value } of instances) {
			const pg = value as PostgresShape;
			if (containerRuntime === null) {
				out.push(unavailablePgStats(pluginKey, pg, 'container runtime unavailable'));
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
					return unavailablePgStats(pluginKey, pg, 'no running postgres container found');
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
						pluginKey,
						pg,
						`psql exited ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`,
					);
				}
				return parsePgStats(pluginKey, pg, result.stdout);
			});
			const stats = yield* probe.pipe(
				Effect.catchCause((cause) =>
					Effect.succeed(unavailablePgStats(pluginKey, pg, String(cause))),
				),
			);
			out.push(stats);
		}
		return out;
	});

	return { mode, deepbook, seal, coinCaps, postgresStats, mintCoin };
};

/** An all-empty dashboard domain. Used by tests that exercise the
 *  schema/server without a live registry. Every accessor resolves to
 *  empty/`null`. */
export const emptyDashboardDomain: DashboardDomain = {
	mode: Effect.succeed(null),
	deepbook: Effect.succeed([]),
	seal: Effect.succeed([]),
	coinCaps: Effect.succeed([]),
	postgresStats: Effect.succeed([]),
	mintCoin: () => Effect.succeed({ ok: false, detail: 'unavailable', digest: null }),
};
