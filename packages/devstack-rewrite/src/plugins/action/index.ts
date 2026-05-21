// Action plugin — barrel + `action(name, opts)` factory.
//
// Architecture (16-action.md): an action is a ONE-SHOT on-chain effect
// (mint, create-singleton-object, seed-config, etc.) that runs after
// its declared upstream refs (typically a signer account + one or more
// published packages) are ready. The result (digest + change arrays)
// is yieldable through the action's tag.
//
// User-facing factory shape (recommended high-level form):
//
//   const openLobby = action('arena.openLobby', {
//     consumes: [alice, connectFour] as const,
//     body: (ctx) =>
//       ctx.signAndExecute(ctx.get(alice.provides), (tx) => {
//         const pkg = ctx.get(connectFour.provides);
//         tx.moveCall({ target: `${pkg.packageId}::game::create_lobby` });
//       }),
//   });
//
// The `ctx.signAndExecute(account, build)` helper folds the full
// build → sign → execute (with `include: {effects, objectTypes}`) →
// wait-for-finality → envelope-projection pipeline into a single call
// (see `execute.ts`). The returned `ActionReceipt` carries the real
// transaction digest and an `objectChanges` array that surfaces the
// SDK's `changedObjects` (with `kind: 'created' | 'mutated'` + the
// fully-qualified `objectType` string when available).
//
// Lower-level bodies (custom signing surfaces, multi-tx flows) can
// drop down to `ctx.tx(build, opts?)` which returns the serialised
// bytes only.
//
// Tag id: `'action:<name>'` — one tag per user-declared action (the
// symbolic name is part of the identity so two `action('foo', ...)`
// calls in one stack collide cleanly at compose time).
//
// Caching: delegated to the substrate's `OnChainArtifactPublisher`.
// Namespace is `action`; the cache key folds chainId + content-hash
// derived from (name, consumedTagIds, dynamic discriminator).

import { Effect, type Scope } from 'effect';

import { Transaction } from '@mysten/sui/transactions';

import { capabilities } from '../../api/define-capabilities.ts';
import { defineNodePlugin } from '../../api/define-plugin.ts';
import { defineTag } from '../../api/tag.ts';
import { OnChainArtifactPublisherService } from '../../substrate/runtime/on-chain-artifact/index.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import type { StackMember } from '../../substrate/plugin.ts';
import type { AnyTag, ResolvedOf } from '../../substrate/tag.ts';
import { SuiTag, type SuiClient } from '../sui/index.ts';
import type { SuiProbeKey } from '../sui/chain-probe.ts';

import type { ActionBuildContext } from './build-context.ts';
import { actionError, ACTION_ERROR_TAGS, type ActionError } from './errors.ts';
import type { DynamicDiscriminator } from './discriminator.ts';
import { signAndExecute as signAndExecuteImpl } from './execute.ts';
import {
	bootActionService,
	resolveDiscriminator,
	type ActionAcquireInputs,
	type ActionReceipt,
} from './service.ts';

// ---------------------------------------------------------------------------
// Tag — one per declared action, keyed by symbolic name
// ---------------------------------------------------------------------------

/** Tag id constructor. The symbolic action name is part of the tag
 *  identity so two `action('foo', ...)` calls in one stack collide
 *  cleanly at compose time. */
export const actionTagId = <Name extends string>(name: Name): `action:${Name}` => `action:${name}`;

export type ActionTagId<Name extends string> = `action:${Name}`;

// ---------------------------------------------------------------------------
// User-facing factory shape
// ---------------------------------------------------------------------------

/** A user-supplied upstream ref (any plugin's `StackMember`). The
 *  factory accepts these in `consumes:` and projects their `.provides`
 *  tag into the plugin's `consumes:` tuple for substrate ordering. */
export type ActionUpstreamMember = StackMember<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AnyTag,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ReadonlyArray<AnyTag>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any
>;

/** Options for `action(name, opts)`. */
export interface ActionOptions<Consumes extends ReadonlyArray<ActionUpstreamMember>> {
	/** Upstream refs the action depends on. Each entry's `.provides`
	 *  tag becomes an edge in the plugin's `consumes:` tuple — the
	 *  substrate orders this action strictly after all entries. */
	readonly consumes: Consumes;
	/** Optional caller-supplied discriminator material. Two shapes:
	 *  a literal `string`, or a callback `(ctx) => Effect<string>`
	 *  that receives the same `ActionBuildContext` the body sees, so
	 *  the discriminator can derive its value from upstream resolved
	 *  refs (e.g. fold in a freshly-published package id). See
	 *  `discriminator.ts`. */
	readonly discriminator?: DynamicDiscriminator<ConsumesTagsOf<Consumes>>;
	/** The user's body. Receives the typed `BuildContext` and returns
	 *  an Effect that performs the on-chain effect (build tx, sign,
	 *  execute) and projects the receipt.
	 *
	 *  Errors raised here surface as `ActionError({phase:'sign'})`
	 *  unless the body raises an `ActionError` itself (in which case
	 *  it propagates verbatim). */
	readonly body: (
		ctx: ActionBuildContext<ConsumesTagsOf<Consumes>>,
	) => Effect.Effect<ActionReceipt, ActionError, Scope.Scope>;
}

/** Project the upstream member tuple into a tag tuple. Preserves
 *  each member's literal tag-id (mirrors `WalletAccountTags` from the
 *  wallet plugin). The `T extends AnyTag` constraint inside the
 *  conditional preserves the literal id AND tells the compiler each
 *  element satisfies `AnyTag` — load-bearing for the
 *  `defineNodePlugin`'s `Consumes extends ReadonlyArray<AnyTag>`
 *  generic constraint downstream. */
type ConsumesTagsOf<C extends ReadonlyArray<ActionUpstreamMember>> = {
	readonly [K in keyof C]: C[K] extends { readonly provides: infer T extends AnyTag } ? T : AnyTag;
};

/** Full `consumes:` tuple for an action plugin instance: SuiTag (hard
 *  upstream) followed by the user-projected upstream tag tuple. The
 *  literal-preserving form is load-bearing for the substrate's
 *  `MissingProviders` check (mirrors `WalletConsumes`). */
type ActionConsumes<C extends ReadonlyArray<ActionUpstreamMember>> = readonly [
	typeof SuiTag,
	...ConsumesTagsOf<C>,
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct the action plugin instance.
 *
 *  The result is a `StackMember` that:
 *
 *   - `provides:` an `ActionReceipt`-typed tag identified by
 *     `action:<name>`,
 *   - `consumes:` `[SuiTag, ...userConsumes]` (Sui hard upstream for
 *     ChainProbe lookup + chainId folding),
 *   - `kind: 'leaf-one-shot'` — Action has no long-lived resources;
 *     the substrate's lifecycle wrap surfaces it as "done" after
 *     `acquire` resolves.
 */
export const action = <
	const Name extends string,
	const Consumes extends ReadonlyArray<ActionUpstreamMember>,
>(
	name: Name,
	opts: ActionOptions<Consumes>,
) => {
	const tag = defineTag<ActionTagId<Name>, ActionReceipt>(actionTagId(name), actionTagId(name));

	// Project the user-supplied upstream members into a typed tag
	// tuple. The substrate uses these for ordering AND for the
	// per-acquire BuildContext walker.
	const upstreamTags = opts.consumes.map((m) => m.provides) as unknown as ConsumesTagsOf<Consumes>;

	// `consumes: [SuiTag, ...userTags]` — SuiTag is the hard upstream
	// the action body NEVER reads directly, but the substrate uses for
	// (a) ordering Sui's chain-probe registration strictly before any
	// action that wants to verify, (b) folding chainId into the cache
	// key. The user's tags follow in declaration order.
	//
	// The `ActionConsumes<Consumes>` alias preserves each literal tag id
	// (mirrors wallet's `WalletConsumes<Accounts>`) so the substrate's
	// stack-composition `MissingProviders` check keeps its narrow ids
	// — without it the tuple widens to `Tag<string, any>[]` and the
	// substrate flags every action's `consumes:` as missing even when
	// the upstream member is present.
	const consumesTuple = [SuiTag, ...upstreamTags] as unknown as ActionConsumes<Consumes>;

	// Static discriminator pieces — known at factory construction
	// time. The tag-ids preserve the literal `id` so two actions with
	// identical bodies but different upstream packages get different
	// cache keys.
	const consumedTagIds = upstreamTags.map(
		(t: { readonly id: string }) => t.id,
	) as ReadonlyArray<string>;

	return defineNodePlugin({
		provides: tag,
		consumes: consumesTuple,
		// Action has no long-lived resources — the body runs once at
		// acquire and returns; supervisor's lifecycle wrap surfaces
		// "done" after that.
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		acquire: (ctx) =>
			Effect.gen(function* () {
				// `ctx.get(SuiTag)` — read chainId + chainProbe lookup
				// edge. SuiTag is hard-included in `consumesTuple` so
				// the runtime invariant holds; the local cast is the
				// localized escape hatch per STYLE_GUIDE §14: when the
				// outer plugin's `Consumes` is a free generic, TS can't
				// reduce `T extends ActionConsumes<Consumes>[number]`
				// for the literal `typeof SuiTag` arg. `ctx.use(member)`
				// is not applicable — SuiTag has no upstream member to
				// thread (it's added by the factory, not the caller).
				const sui = (ctx as { get: (t: typeof SuiTag) => SuiClient }).get(SuiTag);

				// Substrate-context primitives. OCA + strategy registry
				// are both provided by the supervisor's pluginContext.
				const publisher = yield* OnChainArtifactPublisherService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);

				// Compose the user's body Effect, closing over the
				// BuildContext. We project a narrowed BuildContext that
				// forbids reading SuiTag via `get()` (the user's
				// `consumes:` doesn't include it) — keeps the user's
				// surface clean — and surfaces:
				//   - `ctx.sui` — the resolved SuiClient (always set;
				//     SuiTag is the hard upstream).
				//   - `ctx.tx(build, opts)` — low-level helper that
				//     returns the serialised bytes (used when the body
				//     needs to drive a custom signing surface).
				//   - `ctx.signAndExecute(account, build)` — high-level
				//     helper that drives the full build → sign → execute
				//     → wait → project pipeline against the supplied
				//     account, returning a parsed `ActionReceipt`. This
				//     is what most action bodies want — it folds the
				//     SDK-boundary cast + `include: {effects, objectTypes}`
				//     execute + finality wait + envelope projection.
				const bodyCtx: ActionBuildContext<ConsumesTagsOf<Consumes>> = {
					// Forwards typed `get(t)` from the wrapped substrate
					// ctx. Same generic-reduction limitation as the
					// SuiTag cast above (STYLE_GUIDE §14): the substrate
					// ctx's `T extends Provided` constraint doesn't
					// reduce while the action plugin's `Consumes` is a
					// free generic. Cast is localized to one method.
					get: <T extends ConsumesTagsOf<Consumes>[number]>(t: T) =>
						(
							ctx as unknown as {
								get: (tag: T) => ResolvedOf<T>;
							}
						).get(t),
					// Symmetric `use(member)` forwarder. The substrate's
					// `use<M>` signature carries a `TagIdOf<M['provides']>
					// extends TagIdOf<Consumes[number]>` membership check
					// that doesn't reduce for template-literal-generic
					// tag ids while `Consumes` is a free generic — same
					// limitation as `get` above (STYLE_GUIDE §14, Open
					// slot O10). Cast is localized to one method.
					use: ((member) =>
						(
							ctx as unknown as {
								use: (m: typeof member) => unknown;
							}
						).use(member)) as ActionBuildContext<ConsumesTagsOf<Consumes>>['use'],
					sui,
					signAndExecute: (account, build) =>
						signAndExecuteImpl({
							actionName: name,
							sui,
							account,
							build,
						}),
					tx: (build, opts) =>
						Effect.gen(function* () {
							const transaction = new Transaction();
							if (opts?.sender !== undefined) {
								transaction.setSender(opts.sender);
							}
							// The user populates the Transaction synchronously.
							// Throws here surface as ActionError('sign') —
							// mirrors the existing body catch-all phase.
							yield* Effect.try({
								try: () => {
									build(transaction);
								},
								catch: (cause): ActionError =>
									actionError('sign', {
										actionName: name,
										message: `Action '${name}': ctx.tx(build) callback threw before serialisation.`,
										cause,
									}),
							});
							// `Transaction.build({ client })` resolves gas
							// budget + object versions through the SDK.
							// Opaque-cast the client (same boundary cast as
							// the package's publish-executor).
							return yield* Effect.tryPromise({
								try: () =>
									transaction.build({
										client: sui.sdk.client as Parameters<typeof transaction.build>[0] extends
											| { client?: infer C }
											| undefined
											? C
											: never,
									}),
								catch: (cause): ActionError =>
									actionError('sign', {
										actionName: name,
										message: `Action '${name}': Transaction.build failed — ${
											cause instanceof Error ? cause.message : String(cause)
										}.`,
										cause,
									}),
							});
						}),
				};

				const acquireInputs: ActionAcquireInputs = {
					actionName: name,
					chainId: sui.chain,
					staticDiscriminator: {
						actionName: name,
						consumedTagIds,
					},
					dynamicMaterial: resolveDiscriminator(name, opts.discriminator, bodyCtx),
					body: opts.body(bodyCtx),
				};

				const receipt = yield* bootActionService(publisher, probe, acquireInputs).pipe(
					Effect.catch((err): Effect.Effect<ActionReceipt, ActionError> => {
						// Re-wrap the OnChainArtifactError into an
						// ActionError so downstream consumers always see
						// the typed `ActionError` shape. The detail
						// already includes the phase + message from the
						// produce-side mapper.
						if ((err as { _tag?: string })._tag === 'ActionError') {
							return Effect.fail(err as ActionError);
						}
						const detail =
							(err as { detail?: string }).detail ?? `Action '${name}': substrate failure.`;
						return Effect.fail(
							actionError('sign', {
								actionName: name,
								message: detail,
								cause: err,
							}),
						);
					}),
				);
				return receipt;
			}),
		// No capability decls today. Future surfaces (codegen of
		// action receipts, manifest extras) land here.
		capabilities: capabilities(),
		// Plugin-side error vocabulary. The supervisor's harvest loop
		// folds this into the substrate's FormatterRegistry; the
		// cascade formatter then renders `ActionError`-tagged failures
		// with the action's phase/message header.
		errorContributions: [{ _tag: 'PluginErrorContribution', errorTags: ACTION_ERROR_TAGS }],
	});
};

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ActionBuildContext } from './build-context.ts';
export type { ActionError, ActionPhase } from './errors.ts';
export { ACTION_ERROR_TAGS } from './errors.ts';
export type { ActionLifecyclePhase } from './lifecycle.ts';
export type { DynamicDiscriminator, StaticDiscriminator } from './discriminator.ts';
export type { ActionReceipt } from './service.ts';
export { ActionReceiptSchema } from './service.ts';
export type { ActionObjectChange } from './execute.ts';
export { signAndExecute } from './execute.ts';
