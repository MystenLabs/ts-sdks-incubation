// ChainOperation — typed seam for OCA `produce` bodies.
//
// Architecture §10 / STYLE_GUIDE §11 Open slot O1.
//
// Three families of `produce` body exist across the plugin set; the
// OCA `spec.produce: Effect<Produced, OnChainArtifactError, Scope>` is
// the LCD shape that lets every body type-check, but it doesn't carry
// the structural distinction. Plugin authors today reinvent the
// dispatch each time:
//
//   - Move-SDK transactions: `package`, `coin`, `action`, `seal`
//     (deploy + key-server registration), `deepbook` (publish).
//   - In-container shell one-shots: `walrus` (cluster register-known),
//     `seal` (legacy `seal-cli` path).
//   - Pure off-chain register-only flows: `walrus` (known-deployment),
//     callers that already have a digest and only need cache+register.
//
// `ChainOperation<Produced>` is the discriminated union the produce
// body can be expressed as. The helper `compileChainOperation` turns
// one into the `Effect<Produced, OnChainArtifactError, Scope>` shape
// `OnChainArtifactSpec.produce` already accepts — so plugin authors
// migrate by replacing the body of `produce:` with
// `compileChainOperation({...})` without the substrate field shape
// changing.
//
// This module is the typed seam; the substrate does NOT execute the
// op (the `sui-tx` variant defers to `sui-execute`, the `shell-oneshot`
// variant defers to whatever runtime adapter the caller passes in,
// the `register-only` variant produces a value the caller already has
// in hand). Substrate stays name-blind: the variants are
// transport-shapes, not plugin-domain shapes.

import { Effect, Scope } from 'effect';

import type { OnChainArtifactError } from '../../../primitives/on-chain-artifact.ts';
import type { ResolvedSigner } from '../sui-execute/index.ts';

// Re-export the shared signer slice — `chain-operation` and
// `sui-execute` use the SAME signer shape so consumers thread one
// resolved signer through both surfaces.
export type { ResolvedSigner };

// ---------------------------------------------------------------------------
// Variant 1 — Sui-SDK transaction.
// ---------------------------------------------------------------------------

/** Build callback — receives a transaction-builder slot and populates
 *  it (moveCalls, transferObjects, setSender, etc.). The callback is
 *  invoked exactly once per `produce` cycle; failures inside the
 *  callback surface as the wrapping `phase: 'sign'` / build-time
 *  failure of the executor. The transaction-builder type is opaque at
 *  the substrate boundary so this module does not depend on
 *  `@mysten/sui/transactions`. */
export type SuiTxBuilder = (tx: unknown) => void;

/** Opaque Sui effects envelope returned by the executor. The
 *  `parse` callback projects this to the plugin's `Produced` shape.
 *  Substrate doesn't decode the envelope — `sui-execute` does, and the
 *  parse callback receives the projected `ExecutedReceipt` (see
 *  `sui-execute`). The type is left opaque here so this module
 *  doesn't depend on the Sui-execute return shape. */
export type SuiEffects = unknown;

// ---------------------------------------------------------------------------
// Variant 2 — Shell one-shot.
// ---------------------------------------------------------------------------

/** Opaque spec for an in-container shell one-shot. The substrate does
 *  not own the docker-side surface — the caller passes the spec it
 *  would hand to its container-runtime adapter (e.g. `runOneShot`
 *  from `runtime/docker`). The substrate just keeps the slot typed so
 *  the dispatch is exhaustive. */
export interface OneShotSpec {
	readonly image: string;
	readonly argv: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly timeoutMillis?: number;
}

/** Runner closure the caller provides to execute a one-shot. Returned
 *  by the runtime adapter the plugin already yields from context (we
 *  don't reach the adapter from the substrate). */
export type OneShotRunner = (spec: OneShotSpec) => Effect.Effect<string, OnChainArtifactError>;

// ---------------------------------------------------------------------------
// The discriminated union
// ---------------------------------------------------------------------------

/** The discriminated union of `produce` body shapes.
 *
 *  Why three variants:
 *
 *  - `sui-tx` — the Move-SDK transaction shape. `build` populates the
 *    transaction; `executor` does the sign+execute+wait roundtrip and
 *    surfaces an `ExecutedReceipt`-shaped object the `parse` callback
 *    maps to `Produced`. This is the substrate-level seam for
 *    `sui-execute`; the executor closure is what `executeSuiTx`
 *    returns curried over (client, signer).
 *  - `shell-oneshot` — the in-container CLI path (walrus, legacy seal).
 *    `runner` is the caller's runtime adapter closure. The `parse`
 *    callback maps captured stdout to `Produced`.
 *  - `register-only` — the cache+register-only flow where the produced
 *    value is already in hand (walrus known-deployment). Substrate
 *    treats this like a pre-resolved produce. */
export type ChainOperation<Produced> =
	| {
			readonly _tag: 'sui-tx';
			readonly build: SuiTxBuilder;
			readonly signer: ResolvedSigner;
			readonly executor: (
				signer: ResolvedSigner,
				build: SuiTxBuilder,
			) => Effect.Effect<SuiEffects, OnChainArtifactError, Scope.Scope>;
			readonly parse: (effects: SuiEffects) => Effect.Effect<Produced, OnChainArtifactError>;
	  }
	| {
			readonly _tag: 'shell-oneshot';
			readonly spec: OneShotSpec;
			readonly runner: OneShotRunner;
			readonly parse: (stdout: string) => Effect.Effect<Produced, OnChainArtifactError>;
	  }
	| {
			readonly _tag: 'register-only';
			readonly produced: Effect.Effect<Produced, OnChainArtifactError, Scope.Scope>;
	  };

// ---------------------------------------------------------------------------
// Compile to an OCA-spec-compatible Effect
// ---------------------------------------------------------------------------

/**
 * Compile a `ChainOperation<Produced>` into the
 * `Effect<Produced, OnChainArtifactError, Scope>` shape that
 * `OnChainArtifactSpec.produce` accepts.
 *
 * Plugin authors writing a new produce body:
 *
 *     produce: compileChainOperation({
 *       _tag: 'sui-tx',
 *       build: (tx) => { ... },
 *       signer,
 *       executor: executeSuiTx({ client, ... }),
 *       parse: (effects) => Effect.succeed({ ... }),
 *     })
 *
 * The dispatcher is exhaustive — adding a variant to `ChainOperation`
 * surfaces here as a TS error.
 */
export const compileChainOperation = <Produced>(
	op: ChainOperation<Produced>,
): Effect.Effect<Produced, OnChainArtifactError, Scope.Scope> => {
	switch (op._tag) {
		case 'sui-tx':
			return Effect.gen(function* () {
				const effects = yield* op.executor(op.signer, op.build);
				return yield* op.parse(effects);
			}).pipe(
				Effect.withSpan('substrate.onChainArtifact.produce.sui-tx', {
					attributes: { 'oca.produce.variant': 'sui-tx' },
				}),
			);
		case 'shell-oneshot':
			return Effect.gen(function* () {
				const stdout = yield* op.runner(op.spec);
				return yield* op.parse(stdout);
			}).pipe(
				Effect.withSpan('substrate.onChainArtifact.produce.shell-oneshot', {
					attributes: {
						'oca.produce.variant': 'shell-oneshot',
						'oca.produce.image': op.spec.image,
					},
				}),
			);
		case 'register-only':
			return op.produced.pipe(
				Effect.withSpan('substrate.onChainArtifact.produce.register-only', {
					attributes: { 'oca.produce.variant': 'register-only' },
				}),
			);
	}
};
