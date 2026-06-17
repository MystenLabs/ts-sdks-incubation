// Dashboard plugin-domain shaping.
//
// The substrate control-plane is GENERIC + name-blind: it hands out the
// snapshot catalog, the observability rings, and a single uninterpreted
// `resolvedValues` accessor (see `substrate/runtime/control-plane/`). This
// module — which lives in the PLUGIN layer and is allowed to name plugins —
// owns ALL plugin-name-aware shaping: it matches resolved plugin values by
// resource id (`deepbook/`-prefix, `seal:`-prefix, `coin:`-prefix, `id ===
// 'sui'`) and projects them into the app-agnostic shapes the GraphQL schema
// renders. It also owns the `mode` derivation and the coin `mint` action.
//
// Design discipline (mirrors the old substrate seam, one layer up):
//   - We import NO plugin types — we narrow the opaque `unknown` resolved
//     value through shallow structural shapes that mirror the relevant
//     fields. A field missing on the live value collapses to the
//     null/empty default.
//   - Every accessor degrades to empty/`null` rather than failing, so a
//     single missing/uninitialised plugin can't take down a dashboard
//     query (`E = never` on the public surface).
//   - We match plugins by RESOURCE ID — a prefix for the multi-instance
//     kinds (`deepbook/`, `seal:`, `coin:`) and an exact id for the
//     singletons (`id === 'sui'`) — rather than
//     plugin-key substrings: the resource id is the stable identity the
//     plugin factories mint.

import { Effect } from 'effect';

import type {
	ControlPlaneDomain,
	ControlPlaneResolvedValue,
} from '../../substrate/runtime/control-plane/service.ts';
import type { StrategyRegistry } from '../../contracts/strategy-contributor.ts';
import type { FaucetStrategy } from '../../contracts/faucet-strategy.ts';
import type { AccountFundingStrategy } from '../../contracts/funding-strategy.ts';
import type { AccountValue } from '../account/index.ts';
// The faucet capability-key prefix is owned by the faucet plugin (single
// source of truth). The dashboard plugin layer is allowed to name plugins,
// so importing the key constructor is the same cross-plugin reference the
// account funding pass (`plugins/account/funding.ts`) uses — NOT a resolved
// plugin-VALUE import (those stay structurally narrowed below). Imported via
// the sibling's barrel to satisfy the plugin-boundary invariant.
import { FAUCET_CAPABILITY_KEY_PREFIX } from '../faucet/index.ts';

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
	readonly network: string;
	readonly packageId: string;
	readonly registryId: string;
	readonly adminCapId: string | null;
	readonly deepTreasuryId: string | null;
	readonly pools: ReadonlyArray<DashboardDeepbookPool>;
	readonly marketMakerRunning: boolean;
	readonly serverUrl: string | null;
	readonly indexerUrl: string | null;
	/** Non-null when one or more required fields failed to narrow off the
	 *  opaque resolved value (fail-loud: schema drift surfaced to the caller
	 *  instead of silently degrading). */
	readonly narrowingFault: string | null;
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
	/** Non-null when one or more required fields failed to narrow off the
	 *  opaque resolved value (fail-loud). */
	readonly narrowingFault: string | null;
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
	/** Non-null when one or more required fields failed to narrow off the
	 *  opaque resolved value (fail-loud). */
	readonly narrowingFault: string | null;
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

/** Input for the dashboard fund ACTION.
 *
 *  `coinType` selects the funding strategy: absent or the canonical SUI
 *  type routes through the chain's faucet strategy (`faucet:request:<chainId>`,
 *  fixed-amount); any other full coin type routes through the coin-specific
 *  `coinType:<fullCoinType>` strategy (WAL exchange swap / DEEP pool swap).
 *
 *  `amountBaseUnits` is the raw integer amount in the coin's smallest unit
 *  (a string so large u64 values survive the wire without precision loss).
 *  The SUI faucet is fixed-amount and IGNORES it; WAL/DEEP honor it. */
export interface DashboardFundInput {
	readonly recipient: string;
	readonly coinType?: string | null;
	readonly amountBaseUnits?: string | null;
}

/** Outcome of a dashboard fund ACTION. The in-process funding strategies
 *  return `void` (not a digest), so the result carries only `ok`/`detail`.
 *  `ok:true` means the strategy's `request(...)` completed (the faucet POST
 *  landed / the swap executed on-chain); `detail` carries the reason on
 *  failure. */
export interface DashboardFundResult {
	readonly ok: boolean;
	readonly detail: string;
}

/** One coin the dashboard faucet can actually fund, with whether the
 *  underlying strategy honors a caller-supplied amount.
 *
 *  SUI is always present (fixed-amount faucet, `honorsAmount: false`).
 *  WAL/DEEP appear only when their plugin registered a `coinType:<X>`
 *  funding strategy AND (for WAL) carries a swap that spends the
 *  recipient account's SUI — so `honorsAmount: true`. */
export interface DashboardFundableCoin {
	readonly symbol: string;
	readonly coinType: string;
	readonly honorsAmount: boolean;
	/** True when funding requires the recipient to BE a resolved account in
	 *  the stack (the swap spends that account's own SUI via its in-process
	 *  signer). SUI is `false` (any 0x address); WAL/DEEP are `true`. */
	readonly requiresAccountSigner: boolean;
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
	/** Mint ACTION — mints `amountBaseUnits` of `coinType` to `recipient`,
	 *  signed in-process by the treasury-cap-owning publisher signer the
	 *  resolved coin value's self-contained `mintFromCap` closure holds. */
	readonly mintCoin: (input: DashboardMintInput) => Effect.Effect<DashboardMintResult>;
	/** Coins the faucet can actually fund right now (SUI always; WAL/DEEP
	 *  only when their plugin registered a funding strategy). Drives the
	 *  faucet panel's coin pills + amount-field gating. */
	readonly fundableCoins: Effect.Effect<ReadonlyArray<DashboardFundableCoin>>;
	/** Fund ACTION — reuses devstack's in-process funding strategies. SUI
	 *  (absent/canonical type) routes through the chain faucet strategy
	 *  (fixed-amount); WAL/DEEP route through the coin-specific funding
	 *  strategy (account-signed exchange/pool swap). Real result — `ok`
	 *  reflects whether the strategy's `request(...)` completed. */
	readonly fundAccount: (input: DashboardFundInput) => Effect.Effect<DashboardFundResult>;
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
	readonly network?: unknown;
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

interface SuiShape {
	readonly mode?: unknown;
	/** Genesis-digest chain id (`'sui:localnet'`, `'sui:testnet'`,
	 *  `'sui:mainnet-fork@123'`). Composes the faucet capability key
	 *  (`faucet:request:<chainId>`) the SUI funding path resolves. */
	readonly chainId?: unknown;
}

/** Structural shape of the resolved account value (`account/<name>`). The
 *  WAL/DEEP funding strategies need this handle as `req.account` — the swap
 *  spends the recipient account's own SUI through its in-process signer.
 *  Narrowed to the fields the strategy dispatch reads; the full
 *  `AccountValue` is assignable to it, so we cast the matched value across
 *  the seam without importing the account VALUE shape structurally
 *  elsewhere. */
interface AccountShape {
	readonly address?: unknown;
	readonly name?: unknown;
}

/** A 0x-prefixed Sui address: `0x` + 1..64 hex digits. Mirrors the
 *  address validation the mint PTB's `tx.pure.address` ultimately
 *  enforces, surfaced up front so the dashboard gets a clean rejection
 *  rather than an opaque build failure. */
const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;

/** The canonical builtin SUI coin type — selects the SUI faucet funding
 *  path. Mirrors `SUI_FULL_COIN_TYPE` in `plugins/account/funding.ts`
 *  (inlined here so the dashboard plugin does not cross-import the account
 *  funding module just for the string). */
const SUI_FULL_COIN_TYPE = '0x2::sui::SUI' as const;

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

/** Compose the chain faucet capability key (`faucet:request:<chainId>`)
 *  the SUI funding path resolves. Uses the faucet plugin's prefix constant
 *  (single source of truth) — same key the boot-time funding pass builds. */
const faucetCapabilityKeyFor = (
	chain: string,
): `${typeof FAUCET_CAPABILITY_KEY_PREFIX}:${string}` => `${FAUCET_CAPABILITY_KEY_PREFIX}:${chain}`;

/** Parse a base-unit amount string into a positive bigint, or `null` when
 *  absent / non-positive / non-integer. */
const parseAmount = (s: string | null | undefined): bigint | null => {
	if (s == null) return null;
	const trimmed = s.trim();
	if (!isPositiveIntegerString(trimmed)) return null;
	return BigInt(trimmed);
};

/** Derive a display symbol from a full coin type's module path
 *  (`0x…::wal::WAL` → `WAL`, `0x…::deep::DEEP` → `DEEP`). Falls back to the
 *  struct name, then the raw type. Keeps the dashboard name-blind on the
 *  resolved coin VALUE while still labeling the faucet pill. */
const coinSymbolFromType = (coinType: string): string => {
	const parts = coinType.split('::');
	const struct = parts[parts.length - 1];
	return struct !== undefined && struct.length > 0 ? struct : coinType;
};

/** Extract a human detail from a faucet/funding strategy failure. The
 *  strategy error channels are tagged structs carrying `message`/`reason`;
 *  read them structurally without importing each plugin's error type. */
const causeDetail = (cause: unknown): string => {
	if (cause !== null && typeof cause === 'object') {
		const c = cause as {
			readonly message?: unknown;
			readonly reason?: unknown;
			readonly _tag?: unknown;
		};
		if (typeof c.message === 'string' && c.message.length > 0) return c.message;
		if (typeof c.reason === 'string' && c.reason.length > 0) return c.reason;
		if (typeof c._tag === 'string' && c._tag.length > 0) return c._tag;
	}
	return String(cause);
};
const faucetCauseDetail = causeDetail;
const fundingCauseDetail = causeDetail;

// -----------------------------------------------------------------------------
// Fail-aware structural narrowing
//
// The substrate hands us opaque `unknown` resolved values. We still narrow
// through shallow structural shapes, but instead of SILENTLY degrading a
// missing/wrong-typed required field to ''/0 (which hid integration-seam
// drift), the `req*` readers ACCUMULATE a typed narrowing fault into a
// per-shaping-call collector. The fault is threaded into the GraphQL-visible
// result (`narrowingFault` / `detail`) so consumers SEE the drift — WITHOUT
// ever throwing (the dashboard's `E = never` surface semantic is preserved).
// `opt*` readers stay quiet: they are for genuinely-optional fields.
// -----------------------------------------------------------------------------

/** Mutable per-call sink for structural-narrowing faults. */
type FaultSink = Array<string>;

const newFaults = (): FaultSink => [];

/** Collapse accumulated faults into a single nullable detail string for the
 *  GraphQL-visible result. `null` when nothing drifted. */
const faultDetail = (faults: FaultSink): string | null =>
	faults.length === 0 ? null : faults.join('; ');

/** Describe why a value failed to narrow to the expected type — distinguishing
 *  'absent' from 'present but wrong type'. */
const typeFault = (field: string, expected: string, v: unknown): string => {
	if (v === undefined || v === null) return `${field}: missing (expected ${expected})`;
	return `${field}: expected ${expected}, got ${typeof v}`;
};

/** Required string. On mismatch records a fault and returns '' so the panel
 *  still renders a (degraded) cell. */
const reqStr = (v: unknown, field: string, faults: FaultSink): string => {
	if (typeof v === 'string') return v;
	faults.push(typeFault(field, 'string', v));
	return '';
};

/** Required finite number. On mismatch records a fault and returns the safe
 *  display fallback (`fallback`, default 0). */
const reqNum = (v: unknown, field: string, faults: FaultSink, fallback = 0): number => {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	faults.push(typeFault(field, 'number', v));
	return fallback;
};

/** Allow-list enum narrow. Records a fault for an out-of-enum value while
 *  still returning a safe display fallback so the panel renders. */
const narrowEnum = <T extends string>(
	raw: unknown,
	allowed: ReadonlyArray<T>,
	field: string,
	faults: FaultSink,
	fallback: T,
): T => {
	if (typeof raw === 'string' && (allowed as ReadonlyArray<string>).includes(raw)) return raw as T;
	faults.push(
		raw === undefined || raw === null
			? `${field}: missing (expected one of ${allowed.join('|')})`
			: `${field}: '${String(raw)}' not in ${allowed.join('|')}`,
	);
	return fallback;
};

// Genuinely-optional readers — silent by design (absent is a valid state).
const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const optNum = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean => v === true;

/** Filter the generic resolved values down to those whose resource id
 *  matches a predicate, in graph order. Returns the `{ pluginKey, value }`
 *  the shaping functions consume. */
const matching = (
	values: ReadonlyArray<ControlPlaneResolvedValue>,
	matches: (resourceId: string) => boolean,
): ReadonlyArray<ControlPlaneResolvedValue> => values.filter((v) => matches(v.id));

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export interface DashboardDomainDeps {
	/** The generic, name-blind control-plane domain (resolved values). */
	readonly control: ControlPlaneDomain;
	/** The scope-local strategy registry — the SAME registry the boot-time
	 *  account funding pass dispatches through (`plugins/account/funding.ts`).
	 *  Drives `fundableCoins` + `fundAccount`: SUI via `faucet:request:<chainId>`,
	 *  WAL/DEEP via `coinType:<fullCoinType>`. `null` in bare test paths; the
	 *  fund accessors degrade to unavailable then. */
	readonly strategyRegistry: StrategyRegistry | null;
}

export const buildDashboardDomain = (deps: DashboardDomainDeps): DashboardDomain => {
	const { control, strategyRegistry } = deps;

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
					const faults = newFaults();
					const dbMode = narrowEnum(
						v.mode,
						['local', 'override', 'known'] as const,
						'deepbook.mode',
						faults,
						'local',
					);
					return {
						pluginKey,
						name: pluginKey.replace(/^deepbook:/, ''),
						mode: dbMode,
						network: reqStr(v.network, 'deepbook.network', faults),
						packageId: reqStr(v.packageId, 'deepbook.packageId', faults),
						registryId: reqStr(v.registryId, 'deepbook.registryId', faults),
						adminCapId: optStr(v.adminCapId),
						deepTreasuryId: optStr(v.deepTreasuryId),
						pools: (v.pools ?? []).map((p, i) => ({
							name: reqStr(p.name, `deepbook.pools[${i}].name`, faults),
							poolId: reqStr(p.poolId, `deepbook.pools[${i}].poolId`, faults),
							baseCoinType: reqStr(p.baseCoinType, `deepbook.pools[${i}].baseCoinType`, faults),
							quoteCoinType: reqStr(p.quoteCoinType, `deepbook.pools[${i}].quoteCoinType`, faults),
						})),
						marketMakerRunning: bool(v.marketMakerRunning),
						serverUrl: optStr(v.serverUrl),
						indexerUrl: optStr(v.indexerUrl),
						narrowingFault: faultDetail(faults),
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
					const faults = newFaults();
					const sealMode = narrowEnum(
						v.mode,
						['local-keygen', 'live', 'fork-known'] as const,
						'seal.mode',
						faults,
						'local-keygen',
					);
					const keyServers = (v.serverConfigs ?? []).map((c, i) => ({
						objectId: reqStr(c.objectId, `seal.serverConfigs[${i}].objectId`, faults),
						weight: optNum(c.weight) ?? 1,
					}));
					return {
						pluginKey,
						mode: sealMode,
						objectId: reqStr(v.objectId, 'seal.objectId', faults),
						keyServerUrl: reqStr(v.keyServerUrl, 'seal.keyServerUrl', faults),
						keyServers,
						threshold: keyServers.length,
						narrowingFault: faultDetail(faults),
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
					const faults = newFaults();
					const source = narrowEnum(
						v.source,
						['registry', 'on-chain', 'builtin'] as const,
						'coin.source',
						faults,
						'on-chain',
					);
					return {
						pluginKey,
						symbol: optStr(v.symbol),
						fullCoinType: reqStr(v.fullCoinType, 'coin.fullCoinType', faults),
						decimals: reqNum(v.decimals, 'coin.decimals', faults, 0),
						source,
						treasuryCapId: optStr(v.treasuryCapId),
						packageId: optStr(v.packageId),
						narrowingFault: faultDetail(faults),
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
			// `coinCaps` query surfaced. Read `fullCoinType` fail-loud so a coin
			// value missing/empty `fullCoinType` names the REAL cause (a drifted
			// resolved shape) rather than collapsing into the generic
			// 'no resolved coin found' reject.
			const values = yield* control.resolvedValues;
			const candidates = matching(values, (id) => id.startsWith('coin:')).map(
				({ value }) => value as CoinShape,
			);
			const matchFaults = newFaults();
			const match = candidates.find(
				(v) => reqStr(v.fullCoinType, 'coin.fullCoinType', matchFaults) === input.coinType,
			);

			if (match === undefined) {
				const fault = faultDetail(matchFaults);
				return {
					ok: false,
					detail:
						fault === null
							? `no resolved coin found for type '${input.coinType}'`
							: `no resolved coin found for type '${input.coinType}' (${fault})`,
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

	// --- Fund ACTION + fundable-coin derivation ------------------------
	//
	// Reuses devstack's IN-PROCESS funding strategies — the same strategy
	// registry the boot-time account funding pass dispatches through
	// (`plugins/account/funding.ts`). We never re-implement signing or the
	// exchange/pool swaps:
	//
	//   - SUI (absent / canonical type) → `faucet:request:<chainId>`. The SUI
	//     faucet strategy takes `{ address, amount }` only (no account handle)
	//     and is FIXED-AMOUNT (the standard faucet ignores `amount`). Recipient
	//     may be ANY 0x address.
	//   - WAL/DEEP → `coinType:<fullCoinType>`. The strategy takes
	//     `{ address, amount, account }` and runs an account-signed swap, so
	//     the recipient MUST be a resolved account in the stack (we match the
	//     recipient address against the resolved `account/<name>` values and
	//     pass the live `AccountValue` as `req.account`).
	//
	// Never fails (`E = never`): every reject path degrades to
	// `{ ok:false, detail }` so a single bad fund can't take down the query.

	/** The chain id the SUI funding path keys on, read from the resolved sui
	 *  value (same `chainId` field the sui codegen/snapshot decls stamp). */
	const readChainId = control.resolvedValues.pipe(
		Effect.map((values) => {
			const sui = matching(values, (id) => id === 'sui')[0];
			return sui === undefined ? null : optStr((sui.value as SuiShape).chainId);
		}),
	);

	const fundableCoins: DashboardDomain['fundableCoins'] = Effect.gen(function* () {
		// SUI is always fundable when a faucet strategy is registered for the
		// active chain; the fixed-amount faucet ignores the requested amount.
		const out: DashboardFundableCoin[] = [];
		if (strategyRegistry === null) return out;

		const chain = yield* readChainId;
		const keys = yield* strategyRegistry.list();
		if (chain !== null && keys.includes(faucetCapabilityKeyFor(chain))) {
			out.push({
				symbol: 'SUI',
				coinType: SUI_FULL_COIN_TYPE,
				honorsAmount: false,
				requiresAccountSigner: false,
			});
		}

		// A coin is fundable iff a `coinType:<fullCoinType>` strategy is actually
		// registered (the walrus/deepbook/coin plugin contributed one). Derive the
		// display symbol from the coin type's module path (`::wal::WAL` → WAL,
		// `::deep::DEEP` → DEEP) so we stay name-blind on the coin VALUE while
		// still labeling the pill. `requiresAccountSigner` is read from the
		// strategy's own `requiresRecipientAccount` flag — NOT assumed true for
		// every coin: WAL/DEEP swaps spend the recipient's SUI (true), but a
		// managed-coin MINT strategy transfers to a passive recipient (false), so
		// it can fund any 0x address.
		for (const key of keys) {
			if (!key.startsWith('coinType:')) continue;
			const coinType = key.slice('coinType:'.length);
			if (coinType === SUI_FULL_COIN_TYPE) continue;
			const strategy = yield* strategyRegistry
				.get<typeof key, AccountFundingStrategy<unknown, AccountValue>>(key)
				.pipe(Effect.catchTag('StrategyNotFoundError', () => Effect.succeed(null)));
			out.push({
				symbol: coinSymbolFromType(coinType),
				coinType,
				honorsAmount: true,
				requiresAccountSigner: strategy?.requiresRecipientAccount ?? false,
			});
		}
		return out;
	});

	const fundAccount: DashboardDomain['fundAccount'] = (input) =>
		Effect.gen(function* () {
			const recipient = input.recipient.trim();
			if (!SUI_ADDRESS_RE.test(recipient)) {
				return {
					ok: false,
					detail: `invalid recipient '${input.recipient}': expected a 0x-prefixed Sui address`,
				} satisfies DashboardFundResult;
			}
			if (strategyRegistry === null) {
				return {
					ok: false,
					detail: 'funding unavailable: no strategy registry wired',
				} satisfies DashboardFundResult;
			}

			const coinType = input.coinType?.trim() ?? '';
			const isSui = coinType === '' || coinType === SUI_FULL_COIN_TYPE;

			// SUI path — chain faucet strategy. Fixed-amount: we pass a nominal
			// amount but the standard faucet ignores it. Recipient may be any
			// 0x address (no account handle required).
			if (isSui) {
				const chain = yield* readChainId;
				if (chain === null) {
					return {
						ok: false,
						detail: 'cannot fund SUI: no resolved sui plugin / chain id in this stack',
					} satisfies DashboardFundResult;
				}
				const key = faucetCapabilityKeyFor(chain);
				const strategy = yield* strategyRegistry
					.get<typeof key, FaucetStrategy>(key)
					.pipe(Effect.catchTag('StrategyNotFoundError', () => Effect.succeed(null)));
				if (strategy === null) {
					return {
						ok: false,
						detail: `no SUI faucet strategy registered for chain '${chain}'`,
					} satisfies DashboardFundResult;
				}
				// `amount` is nominal — the standard faucet grant is fixed and
				// ignores it. Default to 1 SUI in MIST so a strategy that DID
				// honor it lands a sane value.
				const amount = parseAmount(input.amountBaseUnits) ?? 1_000_000_000n;
				return yield* strategy.request({ address: recipient, amount }).pipe(
					Effect.map(
						(): DashboardFundResult => ({
							ok: true,
							detail: `requested SUI for ${recipient} (fixed-amount faucet grant)`,
						}),
					),
					Effect.catch((cause) =>
						Effect.succeed<DashboardFundResult>({
							ok: false,
							detail: `SUI faucet request failed: ${faucetCauseDetail(cause)}`,
						}),
					),
					Effect.catchCause((cause) =>
						Effect.succeed<DashboardFundResult>({
							ok: false,
							detail: `SUI faucet request crashed: ${String(cause)}`,
						}),
					),
				);
			}

			// WAL/DEEP path — coin-specific account-signed funding strategy.
			const amount = parseAmount(input.amountBaseUnits);
			if (amount === null) {
				return {
					ok: false,
					detail: `invalid amountBaseUnits '${input.amountBaseUnits ?? ''}': expected a positive integer string`,
				} satisfies DashboardFundResult;
			}

			const key = `coinType:${coinType}` as const;
			const strategy = yield* strategyRegistry
				.get<typeof key, AccountFundingStrategy<unknown, AccountValue>>(key)
				.pipe(Effect.catchTag('StrategyNotFoundError', () => Effect.succeed(null)));
			if (strategy === null) {
				return {
					ok: false,
					detail:
						`no funding strategy registered for coin '${coinType}' — ` +
						'WAL needs the walrus plugin (with an exchange) and DEEP needs the deepbook plugin',
				} satisfies DashboardFundResult;
			}

			// Match the recipient to a resolved account, if one holds this address.
			const values = yield* control.resolvedValues;
			const account = matching(values, (id) => id.startsWith('account/'))
				.map(({ value }) => value as AccountShape)
				.find((v) => optStr(v.address) === recipient);

			// Account-spending strategies (WAL/DEEP) swap the recipient's OWN SUI,
			// so the recipient must BE a resolved account with a signer. Mint-style
			// strategies (managed coins) transfer to a passive recipient, so any 0x
			// address is fine — gate the rejection on the strategy's flag, not on
			// the coin being non-SUI.
			if (strategy.requiresRecipientAccount === true && account === undefined) {
				return {
					ok: false,
					detail:
						`coin '${coinType}' is funded by an account-signed swap, but '${recipient}' ` +
						'is not a resolved account in this stack — fund a configured account (the swap spends its SUI)',
				} satisfies DashboardFundResult;
			}

			return yield* strategy
				.request({
					address: recipient,
					amount,
					...(account === undefined ? {} : { account: account as unknown as AccountValue }),
				})
				.pipe(
					Effect.map(
						(): DashboardFundResult => ({
							ok: true,
							detail: `funded ${amount} base units of ${coinType} to ${recipient}`,
						}),
					),
					Effect.catch((cause) =>
						Effect.succeed<DashboardFundResult>({
							ok: false,
							detail: `${coinSymbolFromType(coinType)} funding failed: ${fundingCauseDetail(cause)}`,
						}),
					),
					Effect.catchCause((cause) =>
						Effect.succeed<DashboardFundResult>({
							ok: false,
							detail: `${coinSymbolFromType(coinType)} funding crashed: ${String(cause)}`,
						}),
					),
				);
		});

	return {
		mode,
		deepbook,
		seal,
		coinCaps,
		mintCoin,
		fundableCoins,
		fundAccount,
	};
};

/** An all-empty dashboard domain. Used by tests that exercise the
 *  schema/server without a live registry. Every accessor resolves to
 *  empty/`null`. */
export const emptyDashboardDomain: DashboardDomain = {
	mode: Effect.succeed(null),
	deepbook: Effect.succeed([]),
	seal: Effect.succeed([]),
	coinCaps: Effect.succeed([]),
	mintCoin: () => Effect.succeed({ ok: false, detail: 'unavailable', digest: null }),
	fundableCoins: Effect.succeed([]),
	fundAccount: () => Effect.succeed({ ok: false, detail: 'unavailable' }),
};
