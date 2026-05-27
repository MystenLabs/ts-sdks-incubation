// Action plugin — barrel + `action(name, opts)` factory.
//
// Architecture (16-action.md): an action is a ONE-SHOT on-chain effect
// (mint, create-singleton-object, seed-config, etc.) that runs after
// its declared upstream refs (typically a signer account + one or more
// published packages) are ready. The result (digest + change arrays)
// is yieldable through the action resource.
//
// User-facing factory shape (recommended high-level form):
//
//   const openLobby = action('connect-four.openLobby', {
//     dependsOn: { signer: alice, pkg: connectFour },
//     body: (ctx, { signer, pkg }) =>
//       ctx.signAndExecute(signer, (tx) => {
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
// Resource id: `'action:<name>'` — one tag per user-declared action (the
// symbolic name is part of the identity so two `action('foo', ...)`
// calls in one stack collide cleanly at compose time).
//
// Caching: delegated to the substrate's `ArtifactPublisher`.
// Namespace is `action`; the cache key folds chainId + content-hash
// derived from (name, dependencyResourceIds, dynamic discriminator).

import { Effect, type Scope } from 'effect';

import {
	definePlugin,
	dependencyList,
	resource,
	resolveDependencyValues,
	type AnyResourceRef,
	type DependencyInput,
	type ResolvedDependencies,
} from '../../api/define-plugin.ts';
import { pluginErrorContributions } from '../../api/plugin-errors.ts';
import { ArtifactPublisherService } from '../../substrate/runtime/artifact-publisher/index.ts';
import { chainProbeFor } from '../../substrate/runtime/strategy-registry/index.ts';
import { suiResource, type SuiProbeKey } from '../sui/index.ts';

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

const actionErrorContributions = pluginErrorContributions(ACTION_ERROR_TAGS);

// ---------------------------------------------------------------------------
// Resource — one per declared action, keyed by symbolic name
// ---------------------------------------------------------------------------

/** Resource id constructor. The symbolic action name is part of the tag
 *  identity so two `action('foo', ...)` calls in one stack collide
 *  cleanly at compose time. */
export const actionResourceId = <Name extends string>(name: Name): `action:${Name}` =>
	`action:${name}`;

export type ActionResourceId<Name extends string> = `action:${Name}`;

// ---------------------------------------------------------------------------
// User-facing factory shape
// ---------------------------------------------------------------------------

/** A user-supplied upstream resource ref. The user passes plugin values
 *  such as `account('alice')` or `localPackage('demo', ...)`; object,
 *  tuple, and single-ref shapes are preserved for the action body. */
export type ActionUpstreamRef = AnyResourceRef;

/** Options for `action(name, opts)`. */
type ActionDependencySpec = DependencyInput;

type ResolvedActionDependencies<Input extends ActionDependencySpec> = ResolvedDependencies<Input>;

export interface ActionOptions<DependsOn extends ActionDependencySpec> {
	/** Upstream refs the action depends on. The shape determines the
	 *  second argument passed to `body`. */
	readonly dependsOn: DependsOn;
	/** Optional caller-supplied discriminator material. Two shapes:
	 *  a literal `string`, or a callback `(ctx, deps) => Effect<string>`
	 *  that receives action helpers plus resolved deps shaped like
	 *  `dependsOn`, so the discriminator can derive its value from
	 *  upstream resolved values. See
	 *  `discriminator.ts`. */
	readonly discriminator?: DynamicDiscriminator<ResolvedActionDependencies<DependsOn>>;
	/** The user's body. Receives action helpers plus resolved deps
	 *  shaped like `dependsOn`, then returns the on-chain effect.
	 *
	 *  Errors raised here surface as `ActionError({phase:'sign'})`
	 *  unless the body raises an `ActionError` itself (in which case
	 *  it propagates verbatim). */
	readonly body: (
		ctx: ActionBuildContext,
		deps: ResolvedActionDependencies<DependsOn>,
	) => Effect.Effect<ActionReceipt, ActionError, Scope.Scope>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Construct the action plugin instance.
 *
 *  The result is a plugin/resource ref that:
 *
 *   - publishes an `ActionReceipt`-typed resource identified by
 *     `action:<name>`,
 *   - `dependsOn:` `[suiResource, ...userDependencies]` (Sui hard upstream for
 *     ChainProbe lookup + chainId folding),
 *   - `role: 'task'` — Action has no long-lived resources;
 *     the substrate's lifecycle wrap surfaces it as "done" after
 *     `start` resolves.
 */
export const action = <const Name extends string, const DependsOn extends ActionDependencySpec>(
	name: Name,
	opts: ActionOptions<DependsOn>,
) => {
	const actionRef = resource<ActionResourceId<Name>, ActionReceipt>(actionResourceId(name));

	// Flatten the user-supplied upstream refs for ordering. The start
	// body below keeps the original `dependsOn` shape so it can
	// reconstruct the user's dependency argument.
	const upstreamRefs = dependencyList(opts.dependsOn);
	const dependencies = [suiResource, ...upstreamRefs] as const;

	// Static discriminator pieces — known at factory construction
	// time. The tag-ids preserve the literal `id` so two actions with
	// identical bodies but different upstream packages get different
	// cache keys.
	const dependencyResourceIds = upstreamRefs.map(({ id }) => id) as ReadonlyArray<string>;

	return definePlugin({
		id: actionRef.id,
		dependsOn: dependencies,
		// Action has no long-lived resources — the body runs once at
		// acquire and returns; supervisor's lifecycle wrap surfaces
		// "done" after that.
		role: 'task',
		start: (deps) =>
			Effect.gen(function* () {
				const [sui, ...resolvedUpstream] = deps;
				const resolvedByResourceId = new Map<string, unknown>(
					upstreamRefs.map((ref, index) => [ref.id, resolvedUpstream[index]]),
				);
				const readDeclaredDependency = (id: string): unknown => {
					if (!resolvedByResourceId.has(id)) {
						throw new Error(`Action '${name}': dependency '${id}' was not resolved.`);
					}
					return resolvedByResourceId.get(id);
				};

				// Substrate-context primitives. artifact publisher + strategy registry
				// are both provided by the supervisor's pluginContext.
				const publisher = yield* ArtifactPublisherService;
				const probe = yield* chainProbeFor<SuiProbeKey>(sui.chain);

				// Compose the user's body Effect, closing over the
				// action helper context. Resolved upstream values are
				// passed separately in the same shape as `dependsOn`.
				//   - `ctx.sui` — the resolved SuiClient (always set;
				//     suiResource is the hard upstream).
				//   - `ctx.signAndExecute(account, build)` — high-level
				//     helper that drives the full build → sign → execute
				//     → wait → project pipeline against the supplied
				//     account, returning a parsed `ActionReceipt`. This
				//     is what most action bodies want — it folds the
				//     SDK-boundary cast + `include: {effects, objectTypes}`
				//     execute + finality wait + envelope projection.
				const bodyCtx: ActionBuildContext = {
					sui,
					signAndExecute: (account, build) =>
						signAndExecuteImpl({
							actionName: name,
							sui,
							account,
							build,
						}),
				};

				const bodyDeps = resolveDependencyValues(opts.dependsOn, (member) =>
					readDeclaredDependency(member.id),
				) as ResolvedActionDependencies<DependsOn>;
				const acquireInputs: ActionAcquireInputs = {
					actionName: name,
					chainId: sui.chain,
					staticDiscriminator: {
						actionName: name,
						dependencyResourceIds,
					},
					dynamicMaterial: resolveDiscriminator(name, opts.discriminator, bodyCtx, bodyDeps),
					body: opts.body(bodyCtx, bodyDeps),
				};

				const receipt = yield* bootActionService(publisher, probe, acquireInputs).pipe(
					Effect.catch((err): Effect.Effect<ActionReceipt, ActionError> => {
						// Re-wrap the ArtifactPublishError into an
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
		capabilities: [] as const,
		// Plugin-side error vocabulary. The supervisor's harvest loop
		// folds this into the substrate's FormatterRegistry; the
		// cascade formatter then renders `ActionError`-tagged failures
		// with the action's phase/message header.
		errorContributions: actionErrorContributions,
	});
};

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ActionBuildContext } from './build-context.ts';
export type { ActionError, ActionPhase } from './errors.ts';
export { ACTION_ERROR_TAGS } from './errors.ts';
export type { DynamicDiscriminator, StaticDiscriminator } from './discriminator.ts';
export type { ActionReceipt } from './service.ts';
export { ActionReceiptSchema } from './service.ts';
export type { ActionObjectChange } from './execute.ts';
export { signAndExecute } from './execute.ts';

export { ActionSpans } from './spans.ts';
