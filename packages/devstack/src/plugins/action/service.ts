// Action plugin — main acquire body.
//
// Architecture (16-action.md): an action is a ONE-SHOT on-chain effect
// that runs once per (chain × content-hash), caches its receipt, and
// re-fires when its discriminator changes (or the chain regenesises).
//
// Implementation: thin wrapper over `ArtifactPublisher`. The
// substrate handles the cache → verify → produce → register cycle; this
// file composes the spec:
//
//   - namespace      = `action`
//   - chain          = Sui dependency's resolved `chain`
//   - contentHash    = hash of (actionName, upstreamResourceIds[], dynamic
//                      discriminator if any)
//   - verify         = `chainProbe.get({kind:'transaction', digest},
//                      VerifyTxShape, 'lenient')` — null on transient
//                      or not-found, NOT raise.
//   - produce        = user's `body(ctx)` Effect. Wraps any non-tagged
//                      throw in `ActionError({phase:'sign'})`.
//   - register       = no-op (Action declares no in-process registry —
//                      mirrors v3 `services/action.ts:189-191` "Action
//                      does NOT populate any in-process registries").
//
// Constraints honored:
//
//   - Cache key folds (name, chainId, dependency resource ids, discriminator?) —
//     16-action.md invariant #1.
//   - Dynamic discriminator re-runs on EVERY acquire — invariant #6.
//   - Lenient verify probe — invariant #4.
//   - signAndExecute failure routes via ActionError(phase: 'sign') —
//     invariant #8 (mirroring v3's `PublishError({phase:'publish-tx'})`,
//     but tagged separately so action consumers `catchTag('ActionError')`
//     without clashing with package's tagged error).

import { createHash } from 'node:crypto';

import { Cause, Effect, Schema, type Scope } from 'effect';

import { contentHash as brandContentHash } from '../../substrate/brand.ts';
import {
	artifactPublishError,
	type ArtifactPublishError,
	type ArtifactPublisher,
} from '../../primitives/artifact-publisher.ts';
import { acquireOnChainArtifact } from '../internal/acquire-on-chain-artifact.ts';
import { withPhasePreservingProduce } from '../../substrate/runtime/phase-preserving-produce.ts';
import type { ChainProbe } from '../../contracts/chain-probe.ts';
import type { SuiProbeKey } from '../sui/index.ts';
import type { ActionBuildContext } from './build-context.ts';
import { actionError, type ActionError } from './errors.ts';
import {
	composeDiscriminatorMaterial,
	type DynamicDiscriminator,
	type StaticDiscriminator,
} from './discriminator.ts';
import { ActionSpans } from './spans.ts';

/** Action receipt — the cached value. Minimal shape: digest is the
 *  load-bearing identifier (drives verify probe + downstream
 *  consumers); the change arrays are surfaced opaquely (typed
 *  `unknown` here so the cache schema stays narrow) but the in-memory
 *  shape produced by the `ctx.signAndExecute` helper is
 *  `ActionObjectChange` (`{ kind: 'created' | 'mutated', objectId,
 *  objectType?, outputState?, idOperation? }`). Consumers can cast or
 *  use `findCreatedByType`-style helpers — mirrors v3's
 *  `pickCreatedByType(r.objectChanges, ...)` pattern from
 *  `examples/connect-four/devstack.config.ts`.
 *
 *  Distilled doc §"Capabilities PRODUCED" — the v3 Action's `TxResult`
 *  carries `digest`, `effects`, `objectChanges`, `balanceChanges`. We
 *  narrow to the columns that fit the cache + are actually used by
 *  downstream consumers. */
export interface ActionReceipt {
	readonly digest: string;
	readonly objectChanges?: ReadonlyArray<unknown>;
	readonly balanceChanges?: ReadonlyArray<unknown>;
}

/** Schema for the cached `ActionReceipt`. `objectChanges` /
 *  `balanceChanges` are `Unknown`-typed arrays — we don't enforce the
 *  SDK's wide change-shape here because callers project these
 *  manually (mirrors v3's `pickCreatedByType(r.objectChanges, ...)`
 *  pattern from `examples/connect-four/devstack.config.ts`). */
export const ActionReceiptSchema = Schema.Struct({
	digest: Schema.String,
	objectChanges: Schema.optional(Schema.Array(Schema.Unknown)),
	balanceChanges: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Verify-probe shape — what `getTransaction(digest)` returns on
 *  success. We don't decode the full transaction envelope; presence
 *  of the digest field is the "exists" signal. The lenient probe
 *  already coerces transient + not-found to null. */
const VerifyTxShape = Schema.Struct({
	digest: Schema.String,
});

/** Per-acquire inputs handed to `bootActionService`. The dynamic
 *  discriminator is pre-resolved by `index.ts` — at this layer the
 *  `staticDiscriminator` + optional `dynamicMaterial` string suffice. */
export interface ActionAcquireInputs {
	readonly actionName: string;
	readonly chainId: string;
	readonly staticDiscriminator: StaticDiscriminator;
	/** Resolved dynamic-discriminator material — already projected to
	 *  a string at acquire-time by `index.ts` (the callback form
	 *  receives the `ActionBuildContext` there). */
	readonly dynamicMaterial: Effect.Effect<string | undefined, ActionError>;
	/** The user's body Effect. Receives no parameter — it closes over
	 *  upstream-tag values via the outer `acquire` scope. Returns the
	 *  receipt of the on-chain effect; the plugin caches this. */
	readonly body: Effect.Effect<ActionReceipt, ActionError, Scope.Scope>;
}

/** Resolve a `DynamicDiscriminator` against the action's
 *  action context and resolved dependency values. Two input shapes
 *  (per `DynamicDiscriminator`) collapse onto
 *  `Effect<string | undefined, ActionError>`. */
export const resolveDiscriminator = <Deps>(
	dynamic: DynamicDiscriminator<Deps> | undefined,
	ctx: ActionBuildContext,
	deps: Deps,
): Effect.Effect<string | undefined, ActionError> => {
	if (dynamic === undefined) return Effect.succeed(undefined);
	if (typeof dynamic === 'string') return Effect.succeed(dynamic);
	// The dynamic discriminator's error channel is typed `ActionError`
	// (see `DynamicDiscriminator<Deps>` in `discriminator.ts`), so user
	// failures already arrive in the tagged shape — no wrap or
	// re-projection needed. (Prior code ran `Effect.catch` to fall
	// through tag-or-wrap, but the channel is exhaustively
	// ActionError; the wrap branch was unreachable.)
	return dynamic(ctx, deps);
};

/** Build the verify-probe Effect for a given cached digest. Lenient
 *  mode coerces transient + not-found to null; the substrate then
 *  re-produces on null. */
const buildVerifyProbe = (
	probe: ChainProbe<SuiProbeKey>,
	cachedDigest: string,
): Effect.Effect<typeof VerifyTxShape.Type | null, never> =>
	probe.get({ kind: 'transaction', digest: cachedDigest }, VerifyTxShape, 'lenient').pipe(
		// `decode-failed` on verify is stale shape — null so the
		// substrate re-fires rather than carry forward a mismatch.
		Effect.catch(() => Effect.succeed(null as typeof VerifyTxShape.Type | null)),
	);

/** Main acquire body. Composes the ArtifactSpec for the action
 *  and yields it to the publisher.
 *
 *  Returns the cached/produced `ActionReceipt`. Errors flow as
 *  `ActionError | ArtifactPublishError` — the latter when the substrate
 *  itself surfaces a produce-failure wrap. */
export const bootActionService = (
	publisher: ArtifactPublisher,
	probe: ChainProbe<SuiProbeKey>,
	inputs: ActionAcquireInputs,
): Effect.Effect<ActionReceipt, ActionError | ArtifactPublishError, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			[ActionSpans.name]: inputs.actionName,
			[ActionSpans.chain]: inputs.chainId,
		});

		// --- Pull the pre-projected dynamic-discriminator material
		// (every acquire — hit OR miss). The callback form's
		// `(ctx) => Effect<string>` is invoked by `index.ts` before
		// reaching here, so this layer sees only the resolved Effect.
		const resolvedDynamic = yield* inputs.dynamicMaterial;

		// --- Compose content-hash inputs
		const material = composeDiscriminatorMaterial(inputs.staticDiscriminator, resolvedDynamic);
		const inputsHash = brandContentHash(createHash('sha256').update(material).digest('hex'));

		// --- Phase-preserving produce.
		//
		// `publisher.publish`'s `produce` channel must surface failures
		// as `ArtifactPublishError` per the substrate contract. That
		// erases the original `ActionError.phase`.
		// `withPhasePreservingProduce` stashes the typed `ActionError`
		// in a Ref BEFORE the mapError boundary so the outer recovery
		// (`recoverTypedError`) can re-raise it untouched. The caller in
		// `index.ts` then sees the original `phase` rather than a
		// uniformly-stamped `'sign'`.
		const typedProduce = Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				[ActionSpans.phase]: 'building',
			});
			// `inputs.body` is a USER-SUPPLIED Effect. Two failure
			// surfaces must collapse onto a single `ActionError`:
			//
			//   1. Typed `ActionError` on the failure channel —
			//      `catchTag('ActionError')` re-raises untouched so
			//      the original `phase` survives.
			//   2. Defects (sync `throw` inside the body, `die(...)`)
			//      bypass typed catches entirely — `catchCause` is
			//      the only seam that sees them. Defects get
			//      rebadged to `phase: 'sign'` so a user body that
			//      throws lands on the typed channel rather than
			//      crashing the produce step. Interrupt-only causes
			//      propagate untouched so cancellation semantics
			//      survive.
			const receipt: ActionReceipt = yield* inputs.body.pipe(
				Effect.catchCause((cause) => {
					// 1. Typed `ActionError` on the failure channel —
					//    re-raise untouched so the original `phase`
					//    survives the downstream re-wrap step.
					const failed = Cause.findError(cause);
					if (failed._tag === 'Success') {
						return Effect.fail(failed.success);
					}
					// 2. Interrupt-only causes propagate untouched so
					//    cancellation semantics survive.
					if (Cause.hasInterruptsOnly(cause)) {
						return Effect.failCause(cause);
					}
					// 3. Defects (sync `throw` inside the body, `die(...)`)
					//    bypass typed catches entirely — `catchCause` is
					//    the only seam that sees them. Rebadge to
					//    `phase: 'sign'` so a user body that throws
					//    lands on the typed channel rather than crashing
					//    the produce step.
					const defect = Cause.findDefect(cause);
					const defectValue =
						defect._tag === 'Success' ? defect.success : Cause.squash(cause);
					return Effect.fail(
						actionError('sign', {
							actionName: inputs.actionName,
							message: `Action '${inputs.actionName}': body Effect raised a defect.`,
							cause: defectValue,
						}),
					);
				}),
			);
			yield* Effect.annotateCurrentSpan({
				[ActionSpans.phase]: 'parsing',
				[ActionSpans.digest]: receipt.digest,
			});
			return receipt;
		});

		const { wrappedProduce, recoverTypedError } = yield* withPhasePreservingProduce({
			produce: typedProduce,
			wrapProduceError: (err: ActionError): ArtifactPublishError =>
				artifactPublishError(
					'produce-failed',
					`action.${inputs.actionName} ${err.phase}: ${err.message}`,
				),
		});

		// --- Submit the spec to the publisher.
		//
		// The artifact publisher substrate decodes the cached `ActionReceipt` and
		// passes it into `verify(cached)` — so the verify Effect can
		// pull the digest off the cached payload directly. No
		// in-process registry-hop required (mirrors the seam pattern
		// the package plugin's mode-local TODO calls out).
		const receipt: ActionReceipt = yield* acquireOnChainArtifact<
			ActionReceipt,
			typeof VerifyTxShape.Type
		>(publisher, {
			namespace: 'action',
			chain: inputs.chainId,
			contentHash: inputsHash,
			verify: (cached) => buildVerifyProbe(probe, cached.digest),
			produce: wrappedProduce,
		}).pipe(recoverTypedError);

		// The substrate hands back the decoded `ActionReceipt` on every
		// path (decoded cached payload on hit, fresh produce on miss).
		return receipt;
	}).pipe(
		// Outer span so the per-action `annotateCurrentSpan` annotations
		// above attach to a real span instead of dropping silently when
		// `bootActionService` is invoked outside a parent span.
		Effect.withSpan('devstack.plugin.action.boot', {
			attributes: {
				[ActionSpans.name]: inputs.actionName,
				[ActionSpans.chain]: inputs.chainId,
			},
		}),
	);
