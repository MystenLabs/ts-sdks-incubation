// Dashboard root types — Query / Mutation / Subscription.
//
// Queries expose the live projection (`state`), relay node/connection
// access over the snapshot arrays, and a liveness `ping`. Mutations map to
// `EngineCommand`s. The single subscription streams the projection over the
// SubscriptionRef→async-generator bridge. Dependencies (the `state` ref +
// `publishCommand`) come from the GraphQL context (`ctx`), not closure — the
// dashboard is a pure control plane (no chain reads).

import { Effect, Fiber, Queue, Stream, SubscriptionRef } from 'effect';
import { resolveArrayConnection } from '@pothos/plugin-relay';
import { builder } from './builder.ts';
import {
	Account,
	CoinCap,
	DeepbookInfo,
	FundableCoin,
	LogFilterInput,
	LogRecordType,
	Package,
	SealInfo,
	Service,
	SnapshotEntry,
	StackState,
	type ServiceSource,
} from './types.ts';
import { StackMode } from './enums.ts';
import type { DashboardContext } from './builder.ts';
import type { PluginKey } from '../../../substrate/brand.ts';
import type { EngineCommand } from '../../../substrate/events.ts';
import type { SubscribableState } from '../../../substrate/projection.ts';
import type { LogFilter, LogLevel } from '../../../substrate/runtime/observability/index.ts';

const readSnapshot = (
	state: SubscriptionRef.SubscriptionRef<SubscribableState>,
): Promise<SubscribableState> => Effect.runPromise(SubscriptionRef.get(state));

// --- CommandResult ------------------------------------------------------
interface CommandResultShape {
	readonly ok: boolean;
	readonly command: string;
	readonly message?: string | null;
}

const CommandResult = builder.objectRef<CommandResultShape>('CommandResult').implement({
	description: 'The outcome of dispatching an engine command.',
	fields: (t) => ({
		ok: t.exposeBoolean('ok'),
		command: t.exposeString('command'),
		message: t.string({ nullable: true, resolve: (r) => r.message ?? null }),
	}),
});

const run = async (
	ctx: DashboardContext,
	tag: string,
	command: EngineCommand,
): Promise<CommandResultShape> => {
	await Effect.runPromise(ctx.publishCommand(command));
	return { ok: true, command: tag };
};

// --- SnapshotActionResult -----------------------------------------------
//
// Restore/delete go through the control-plane `domain` (NOT the void
// `publishCommand`), so the dashboard gets a real ok/detail outcome the
// fire-and-forget command channel cannot carry.
interface SnapshotActionResultShape {
	readonly ok: boolean;
	readonly detail: string | null;
}

const SnapshotActionResult = builder
	.objectRef<SnapshotActionResultShape>('SnapshotActionResult')
	.implement({
		description: 'The outcome of a snapshot restore/delete (real result, not fire-and-forget).',
		fields: (t) => ({
			ok: t.exposeBoolean('ok'),
			detail: t.string({ nullable: true, resolve: (r) => r.detail }),
		}),
	});

// --- MintResult ---------------------------------------------------------
//
// The coin Mint action goes through the control-plane `domain` (NOT the
// void `publishCommand`): the supervisor holds the treasury-cap-owning
// signer in-process and returns a real ok/detail outcome plus the on-chain
// tx `digest` on success.
interface MintResultShape {
	readonly ok: boolean;
	readonly detail: string;
	readonly digest: string | null;
}

const MintResult = builder.objectRef<MintResultShape>('MintResult').implement({
	description: 'The outcome of a coin mint (real result, with the on-chain tx digest on success).',
	fields: (t) => ({
		ok: t.exposeBoolean('ok'),
		detail: t.exposeString('detail'),
		digest: t.string({ nullable: true, resolve: (r) => r.digest }),
	}),
});

// --- FundResult ---------------------------------------------------------
//
// The Faucet `fund` action routes through the control-plane `pluginDomain`,
// reusing devstack's IN-PROCESS funding strategies (the same registry the
// boot-time account funding pass uses): SUI via the chain faucet strategy
// (fixed-amount), WAL/DEEP via the coin-specific account-signed swap. The
// strategies return `void` (no digest), so the result carries only
// `ok`/`detail`. `ok` reflects whether the strategy's `request(...)`
// actually completed.
interface FundResultShape {
	readonly ok: boolean;
	readonly detail: string;
}

const FundResult = builder.objectRef<FundResultShape>('FundResult').implement({
	description:
		'The outcome of a faucet fund request (real result — ok reflects whether the ' +
		'in-process funding strategy completed).',
	fields: (t) => ({
		ok: t.exposeBoolean('ok'),
		detail: t.exposeString('detail'),
	}),
});

// --- Query --------------------------------------------------------------
builder.queryType({
	fields: (t) => ({
		/** Liveness probe. */
		ping: t.string({ resolve: () => 'pong' }),
		/** Full live projection snapshot (status, services, endpoints, …). */
		state: t.field({
			type: StackState,
			resolve: (_parent, _args, ctx) => readSnapshot(ctx.state),
		}),
		/** Relay connection over the current snapshot's service rows. */
		services: t.connection({
			type: Service,
			resolve: async (_parent, args, ctx) => {
				const snapshot = await readSnapshot(ctx.state);
				const sources: ServiceSource[] = snapshot.rows.map((row) => ({ row, snapshot }));
				return resolveArrayConnection({ args }, sources);
			},
		}),
		/** Relay connection over the current snapshot's accounts. */
		accounts: t.connection({
			type: Account,
			resolve: async (_parent, args, ctx) => {
				const snapshot = await readSnapshot(ctx.state);
				return resolveArrayConnection({ args }, [...snapshot.accounts]);
			},
		}),
		/** Relay connection over the current snapshot's packages. */
		packages: t.connection({
			type: Package,
			resolve: async (_parent, args, ctx) => {
				const snapshot = await readSnapshot(ctx.state);
				return resolveArrayConnection({ args }, [...snapshot.packages]);
			},
		}),

		// --- Plugin-domain queries (data the browser cannot reach) --------
		/** Fork-vs-local stack mode (advance-clock gating). `null` when no
		 *  sui plugin is present. */
		mode: t.field({
			type: StackMode,
			nullable: true,
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.pluginDomain.mode),
		}),
		/** Snapshot catalog: id/label/created/participants/containers. */
		snapshots: t.field({
			type: [SnapshotEntry],
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.domain.snapshots),
		}),
		/** DeepBook deployments: registry/admin/pool ids + seed-liquidity
		 *  state + Pyth feeds. (Pool prices / order books are chain-direct.) */
		deepbookInfo: t.field({
			type: [DeepbookInfo],
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.pluginDomain.deepbook),
		}),
		/** Seal key-server deployments: objectId/threshold/mode/keyServers. */
		sealInfo: t.field({
			type: [SealInfo],
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.pluginDomain.seal),
		}),
		/** Coin treasury caps (drives Mint) + addressing facts. (Supply /
		 *  metadata are chain-direct.) */
		coinCaps: t.field({
			type: [CoinCap],
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.pluginDomain.coinCaps),
		}),
		/** Coins the faucet can actually fund right now (drives the Faucet
		 *  panel's coin pills + amount gating). SUI is always present when a
		 *  faucet strategy is registered; WAL/DEEP appear only when their
		 *  plugin contributed a funding strategy. */
		fundableCoins: t.field({
			type: [FundableCoin],
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.pluginDomain.fundableCoins),
		}),
		// --- Observability (Console "Logs" tab) ---------------------------
		/** Cross-service queryable log history. Filterable server-side by
		 *  service / level / substring / time window; returns most-recent
		 *  first, capped by `filter.limit` (default = ring capacity). */
		logs: t.field({
			type: [LogRecordType],
			args: { filter: t.arg({ type: LogFilterInput, required: false }) },
			resolve: (_parent, args, ctx) => Effect.runPromise(ctx.domain.logs(toLogFilter(args.filter))),
		}),
		/** Distinct services currently in the log ring (filter dropdown). */
		logServices: t.field({
			type: ['String'],
			resolve: (_parent, _args, ctx) => Effect.runPromise(ctx.domain.logServices),
		}),
	}),
});

/** Closed log-level set used to narrow the String[] filter input back onto
 *  the store's `LogLevel` union. Unknown strings are dropped (the store would
 *  just never match them anyway). */
const LOG_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>([
	'trace',
	'debug',
	'info',
	'warn',
	'error',
	'fatal',
]);

const nonEmpty = (xs: readonly (string | null)[] | null | undefined): string[] | undefined => {
	if (xs == null) return undefined;
	const out = xs.filter((x): x is string => x != null && x.length > 0);
	return out.length > 0 ? out : undefined;
};

/** Map the nullable GraphQL `LogFilter` input onto the store's `LogFilter`,
 *  dropping nulls and unknown levels. */
const toLogFilter = (
	input:
		| {
				services?: readonly (string | null)[] | null;
				levels?: readonly (string | null)[] | null;
				search?: string | null;
				sinceMillis?: number | null;
				limit?: number | null;
		  }
		| null
		| undefined,
): LogFilter | undefined => {
	if (input == null) return undefined;
	const services = nonEmpty(input.services);
	const levelStrings = nonEmpty(input.levels);
	const levels = levelStrings?.filter((l): l is LogLevel => LOG_LEVELS.has(l as LogLevel));
	return {
		...(services ? { services } : {}),
		...(levels && levels.length > 0 ? { levels } : {}),
		...(input.search != null ? { search: input.search } : {}),
		...(input.sinceMillis != null ? { sinceMillis: input.sinceMillis } : {}),
		...(input.limit != null ? { limit: input.limit } : {}),
	};
};

// --- Mutation -----------------------------------------------------------
builder.mutationType({
	fields: (t) => ({
		/** Restart the whole stack. */
		restart: t.field({
			type: CommandResult,
			resolve: (_parent, _args, ctx) => run(ctx, 'stack.restart', { tag: 'stack.restart' }),
		}),
		/** Selectively restart a single plugin subgraph. */
		restartPlugin: t.fieldWithInput({
			type: CommandResult,
			input: { pluginKey: t.input.string({ required: true }) },
			resolve: (_parent, args, ctx) =>
				run(ctx, 'selective-restart.requested', {
					tag: 'selective-restart.requested',
					pluginKey: args.input.pluginKey as PluginKey,
				}),
		}),
		/** Capture a snapshot, optionally naming it. */
		captureSnapshot: t.fieldWithInput({
			type: CommandResult,
			input: { name: t.input.string({ required: false }) },
			resolve: (_parent, args, ctx) =>
				run(ctx, 'snapshot.capture', {
					tag: 'snapshot.capture',
					...(args.input.name == null ? {} : { name: args.input.name }),
				}),
		}),
		/** Re-run codegen against the live manifest. */
		codegen: t.field({
			type: CommandResult,
			resolve: (_parent, _args, ctx) => run(ctx, 'codegen.requested', { tag: 'codegen.requested' }),
		}),
		/** Re-apply the manifest, optionally scoped to a single plugin. */
		apply: t.fieldWithInput({
			type: CommandResult,
			input: { pluginKey: t.input.string({ required: false }) },
			resolve: (_parent, args, ctx) =>
				run(ctx, 'apply.requested', {
					tag: 'apply.requested',
					...(args.input.pluginKey == null ? {} : { pluginKey: args.input.pluginKey as PluginKey }),
				}),
		}),
		/** Wipe the live stack footprint (preserves the snapshot catalog). */
		wipe: t.field({
			type: CommandResult,
			resolve: (_parent, _args, ctx) => run(ctx, 'wipe.requested', { tag: 'wipe.requested' }),
		}),
		/** Prune the snapshot catalog + sweep byproduct images. */
		prune: t.field({
			type: CommandResult,
			resolve: (_parent, _args, ctx) => run(ctx, 'prune.requested', { tag: 'prune.requested' }),
		}),
		/** Advance the (fork/local) chain clock to an absolute epoch-ms. */
		advanceClock: t.fieldWithInput({
			type: CommandResult,
			input: { toMillis: t.input.float({ required: true }) },
			resolve: (_parent, args, ctx) =>
				run(ctx, 'advance-clock.requested', {
					tag: 'advance-clock.requested',
					toMillis: args.input.toMillis,
				}),
		}),
		/** Request a graceful stack shutdown. */
		shutdown: t.field({
			type: CommandResult,
			resolve: (_parent, _args, ctx) =>
				run(ctx, 'shutdown.requested', { tag: 'shutdown.requested' }),
		}),
		/** Restore a snapshot by id. Routes through the supervisor
		 *  command-loop via `submitCommand` (NOT the in-process
		 *  `domain.restoreSnapshot`): restore is destructive — it removes the
		 *  live managed containers and relies on a follow-on re-acquire to
		 *  rebuild them. Running it in-process against a live supervisor would
		 *  race the single command-queue consumer and leave services dead until
		 *  a manual Restart. The command-loop's `snapshot.restore` case applies
		 *  the restored tree, publishes `snapshot.restored`, THEN drains +
		 *  re-acquires every service (the manual-restart sequence) — and the
		 *  submitted-command completion deferred lets this mutation await the
		 *  real ok/detail outcome the void `publishCommand` could not carry. */
		restoreSnapshot: t.fieldWithInput({
			type: SnapshotActionResult,
			input: { id: t.input.string({ required: true }) },
			resolve: (_parent, args, ctx) =>
				Effect.runPromise(
					ctx.submitCommand({ tag: 'snapshot.restore', snapshotId: args.input.id }).pipe(
						Effect.as({ ok: true, detail: null as string | null }),
						Effect.catchCause((cause) =>
							Effect.succeed({ ok: false, detail: String(cause) as string | null }),
						),
					),
				),
		}),
		/** Delete a snapshot by id (via the control-plane `domain`). */
		deleteSnapshot: t.fieldWithInput({
			type: SnapshotActionResult,
			input: { id: t.input.string({ required: true }) },
			resolve: (_parent, args, ctx) => Effect.runPromise(ctx.domain.deleteSnapshot(args.input.id)),
		}),
		/** Mint a custom coin. Routes through the control-plane `domain`:
		 *  the supervisor holds the treasury-cap-owning publisher signer
		 *  in-process and returns a real ok/detail/digest result (the void
		 *  `publishCommand` could not carry the tx digest). `amountBaseUnits`
		 *  is the raw integer amount in the coin's smallest unit (string so
		 *  large u64 values survive the wire without precision loss). */
		mint: t.fieldWithInput({
			type: MintResult,
			input: {
				coinType: t.input.string({ required: true }),
				recipient: t.input.string({ required: true }),
				amountBaseUnits: t.input.string({ required: true }),
			},
			resolve: (_parent, args, ctx) =>
				Effect.runPromise(
					ctx.pluginDomain.mintCoin({
						coinType: args.input.coinType,
						recipient: args.input.recipient,
						amountBaseUnits: args.input.amountBaseUnits,
					}),
				),
		}),
		/** Fund an account/address. Routes through the control-plane
		 *  `pluginDomain`, reusing devstack's in-process funding strategies:
		 *  SUI (absent / canonical `coinType`) via the chain faucet strategy
		 *  (fixed-amount — `amountBaseUnits` is ignored); WAL/DEEP via the
		 *  coin-specific account-signed swap (`amountBaseUnits` honored, and
		 *  the recipient must be a resolved account). Real result — `ok`
		 *  reflects whether the strategy completed. */
		fund: t.fieldWithInput({
			type: FundResult,
			input: {
				recipient: t.input.string({ required: true }),
				coinType: t.input.string({ required: false }),
				amountBaseUnits: t.input.string({ required: false }),
			},
			resolve: (_parent, args, ctx) =>
				Effect.runPromise(
					ctx.pluginDomain.fundAccount({
						recipient: args.input.recipient,
						coinType: args.input.coinType,
						amountBaseUnits: args.input.amountBaseUnits,
					}),
				),
		}),
	}),
});

// --- Subscription -------------------------------------------------------
builder.subscriptionType({
	fields: (t) => ({
		/** Stream the projection on every change (current value first). */
		state: t.field({
			type: StackState,
			subscribe: (_parent, _args, ctx) => subscribeState(ctx.state),
			resolve: (payload) => payload,
		}),
	}),
});

/** Bridge an Effect `SubscriptionRef` to an async iterable for GraphQL
 *  subscriptions. `SubscriptionRef.changes` emits the current value first,
 *  then each subsequent update. The pump fiber is interrupted when the
 *  consumer (yoga) stops iterating. */
async function* subscribeState(
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
): AsyncGenerator<SubscribableState> {
	const queue = Effect.runSync(Queue.unbounded<SubscribableState>());
	const pump = Effect.runFork(
		Stream.runForEach(SubscriptionRef.changes(ref), (snapshot) => Queue.offer(queue, snapshot)),
	);
	try {
		while (true) {
			yield await Effect.runPromise(Queue.take(queue));
		}
	} finally {
		Effect.runFork(Fiber.interrupt(pump));
	}
}
