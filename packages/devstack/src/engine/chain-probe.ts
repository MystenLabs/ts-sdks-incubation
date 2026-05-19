// `ChainProbe` — typed accessor surface over the `@mysten/sui` client's
// raw `client.core.*` responses.
//
// The verify probes in `services/{deepbook,pyth,walrus,seal,coin,...}`
// each reach for `sui.client.core.getObject(...)` and need to read
// fields like `objectType` consistently. ChainProbe Schema-validates
// the response shape so callers can't silently drift on a renamed
// field path.

import { Context, Effect, Layer, Schema } from 'effect';
import { SuiTag } from '../services/sui.js';
import { stringifyCause } from './stringify-cause.js';

// -----------------------------------------------------------------------------
// Schemas — runtime validation of the SDK's response shape
// -----------------------------------------------------------------------------

/**
 * Validated subset of `client.core.getObject(...)`'s `.object` field.
 * The SDK exposes more (digest, content, json, display, …) — we narrow
 * to the fields verify probes actually consult, plus `objectId` /
 * `version` for callers that want to compare against a known version.
 *
 * `owner` is parsed as one of four shapes per the SDK's `ObjectOwner`
 * union (AddressOwner / SharedOwner / ImmutableOwner / others). The
 * normalized {address?, shared?} flat form below is what callers see.
 */
const ObjectOwnerSchema = Schema.Union([
	Schema.Struct({
		$kind: Schema.Literal('AddressOwner'),
		AddressOwner: Schema.String,
	}),
	Schema.Struct({
		$kind: Schema.Literal('Shared'),
		Shared: Schema.Struct({ initialSharedVersion: Schema.String }),
	}),
	Schema.Struct({
		$kind: Schema.Literal('Immutable'),
		Immutable: Schema.Literal(true),
	}),
	Schema.Struct({
		$kind: Schema.Literal('ConsensusAddressOwner'),
		ConsensusAddressOwner: Schema.Unknown,
	}),
	Schema.Struct({
		$kind: Schema.Literal('Parent'),
		Parent: Schema.Unknown,
	}),
	Schema.Struct({
		$kind: Schema.Literal('Unknown'),
		Unknown: Schema.Unknown,
	}),
]);

const RawObjectSchema = Schema.Struct({
	objectId: Schema.String,
	type: Schema.String,
	version: Schema.String,
	owner: ObjectOwnerSchema,
});

/** Validated SDK response shape: `{ object: { objectId, type, ... } }`. */
const GetObjectResponseSchema = Schema.Struct({
	object: RawObjectSchema,
});

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * Normalized owner — verify probes generally care about "what address
 * owns this?" or "is it shared?", not the SDK's tagged-union form.
 * `address` is set for `AddressOwner` and the consensus variant; `shared`
 * is `true` for `SharedOwner`; `immutable` is `true` for `Immutable`.
 * All three are `undefined` for unrecognized owner variants.
 */
export interface ObjectOwnerInfo {
	readonly address?: string;
	readonly shared?: boolean;
	readonly immutable?: boolean;
}

/**
 * Validated subset of `client.core.getObject(...)`'s response. The
 * fields here are the ones verify probes actually consult.
 */
export interface ObjectInfo {
	readonly objectId: string;
	/** Long-form Move type (canonicalised by the SDK). Use
	 *  `moveTypeEquals` / `moveTypeStartsWith` for matching. */
	readonly type: string;
	readonly version: string;
	readonly owner: ObjectOwnerInfo;
}

/**
 * Validated subset of `client.core.getTransaction(...)`'s response. Verify
 * probes that want to confirm "the side effect's receipt still resolves
 * on this chain" use `digest` as the stable identifier (per RS2 in the
 * integration-contract redesign — probe stable ids, not derived shapes).
 */
export interface TransactionInfo {
	readonly digest: string;
}

/**
 * Surfaced by `ChainProbe` when the underlying RPC call fails for a
 * non-"not found" reason (network, gRPC unimplemented, schema-validation
 * fail). The default accessors map all of these to `undefined` at the
 * caller boundary — `ProbeError` exists so callers that want to react
 * to transient RPC failures (vs missing object) can catch it explicitly.
 *
 * `surface` names the accessor (`'getObject'`, `'balance'`, …);
 * `cause` carries the underlying error if any (RPC error, Schema parse
 * issue, etc.) for log surface.
 */
export class ProbeError extends Schema.TaggedErrorClass<ProbeError>()('ProbeError', {
	surface: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

// -----------------------------------------------------------------------------
// ChainProbe service
// -----------------------------------------------------------------------------

/**
 * Typed accessor surface over the Sui SDK. Every verify probe in
 * `services/**` SHOULD go through this — the Schema-validated shape
 * catches SDK drift at the boundary instead
 * of letting a `{type: undefined}` silently fall through into a probe's
 * comparison logic.
 *
 * Default accessors return `undefined` for both "not found" and any
 * transient RPC failure — the rationale (over-derive on the next cycle
 * rather than fail boot) matches `withCache`'s existing convention.
 * Callers that need to distinguish use the `*Strict` variants which
 * return `Effect<T | undefined, ProbeError>` instead.
 */
export class ChainProbe extends Context.Service<
	ChainProbe,
	{
		/**
		 * Fetch a typed object record by id. Returns `undefined` for any
		 * RPC failure, schema validation failure, or missing object — the
		 * common verify-probe shape ("does this object still exist?").
		 */
		readonly getObject: (objectId: string) => Effect.Effect<ObjectInfo | undefined>;

		/**
		 * Strict variant of `getObject` — distinguishes "not found"
		 * (`undefined`) from "RPC / schema failure" (`ProbeError`). Most
		 * verify probes prefer the lenient `getObject` form.
		 */
		readonly getObjectStrict: (
			objectId: string,
		) => Effect.Effect<ObjectInfo | undefined, ProbeError>;

		/**
		 * Probe a list of `(objectId, expectedType)` pairs. Returns
		 * `true` iff every id resolves to an object whose `type` matches
		 * its `expectedType` per the supplied `match` predicate (defaults
		 * to strict string equality). Returns `false` if any object is
		 * missing OR if any type mismatches. Used by multi-object verify
		 * probes (walrus deploy, deepbook pools).
		 *
		 * `match` defaults to strict equality. Callers that need address-
		 * form-agnostic comparison pass `moveTypeEquals` from
		 * `engine/sui-helpers.ts`.
		 */
		readonly objectsMatchTypes: (
			expectations: ReadonlyArray<{
				readonly objectId: string;
				readonly expectedType: string;
			}>,
			match?: (actual: string, expected: string) => boolean,
		) => Effect.Effect<boolean>;

		/**
		 * Fetch a transaction record by digest. Returns `undefined` for
		 * any RPC failure or missing transaction — the "did the side
		 * effect's receipt still resolve?" verify-probe shape (per RS2:
		 * probes that consume stable identifiers from `produce`'s output
		 * are the recommended shape).
		 *
		 * Defensive against partial gRPC client mocks that omit
		 * `core.getTransaction` — treats absence the same way an RPC
		 * error would (returns `undefined`).
		 */
		readonly getTransaction: (digest: string) => Effect.Effect<TransactionInfo | undefined>;
	}
>()('@devstack/ChainProbe') {}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type ObjectOwnerSchemaType = typeof ObjectOwnerSchema.Type;
type RawObjectSchemaType = typeof RawObjectSchema.Type;

const normalizeOwner = (owner: ObjectOwnerSchemaType): ObjectOwnerInfo => {
	switch (owner.$kind) {
		case 'AddressOwner':
			return { address: owner.AddressOwner };
		case 'Shared':
			return { shared: true };
		case 'Immutable':
			return { immutable: true };
		default:
			return {};
	}
};

const toObjectInfo = (raw: RawObjectSchemaType): ObjectInfo => ({
	objectId: raw.objectId,
	type: raw.type,
	version: raw.version,
	owner: normalizeOwner(raw.owner),
});

// -----------------------------------------------------------------------------
// Live implementation — backed by `SuiTag.client.core`
// -----------------------------------------------------------------------------

/**
 * Live `ChainProbe` Layer backed by the `SuiTag` service's gRPC client.
 * Wire alongside `Sui()` when adopting `ChainProbe` in primitive verify
 * probes. Tests that want a deterministic probe (mock object → fixed
 * shape) construct a `Layer.succeed(ChainProbe, { ... })` directly
 * without this layer.
 */
export const ChainProbeLive: Layer.Layer<ChainProbe, never, SuiTag> = Layer.effect(
	ChainProbe,
	Effect.gen(function* () {
		const sui = yield* SuiTag;

		const getObjectStrict = (objectId: string): Effect.Effect<ObjectInfo | undefined, ProbeError> =>
			Effect.gen(function* () {
				const raw: unknown = yield* Effect.tryPromise({
					try: () => sui.client.core.getObject({ objectId }),
					catch: (cause) => cause,
				}).pipe(
					Effect.catch((cause: unknown) => {
						const message = stringifyCause(cause);
						// Heuristic: SDK errors that include "not found" (or the
						// common gRPC `NOT_FOUND` status) collapse to `undefined`
						// — that's the verify-probe semantics callers want.
						// Everything else is a real probe failure.
						if (/not\s*found|NOT_FOUND/i.test(message)) {
							return Effect.succeed(undefined as unknown);
						}
						return Effect.fail(
							new ProbeError({
								surface: 'getObject',
								message,
								cause,
							}),
						);
					}),
				);
				if (raw === undefined) return undefined;
				const decoded = yield* Schema.decodeUnknownEffect(GetObjectResponseSchema)(raw).pipe(
					Effect.mapError(
						(cause) =>
							new ProbeError({
								surface: 'getObject',
								message: `schema validation failed: ${stringifyCause(cause)}`,
								cause,
							}),
					),
				);
				return toObjectInfo(decoded.object);
			});

		const getObject = (objectId: string): Effect.Effect<ObjectInfo | undefined> =>
			getObjectStrict(objectId).pipe(Effect.orElseSucceed(() => undefined));

		const objectsMatchTypes = (
			expectations: ReadonlyArray<{
				readonly objectId: string;
				readonly expectedType: string;
			}>,
			match?: (actual: string, expected: string) => boolean,
		): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const cmp = match ?? ((a: string, b: string) => a === b);
				for (const e of expectations) {
					const fetched = yield* getObject(e.objectId);
					if (fetched === undefined) return false;
					if (!cmp(fetched.type, e.expectedType)) return false;
				}
				return true;
			});

		const getTransaction = (digest: string): Effect.Effect<TransactionInfo | undefined> =>
			Effect.gen(function* () {
				// Defensive: test mocks may satisfy `Sui` with a minimal
				// `client.core` that omits `getTransaction`. Treat absence
				// the same way an RPC error would — return `undefined` so
				// verify-fail triggers a safe re-fire.
				const core = (sui.client as unknown as { readonly core?: unknown }).core;
				const fn = (core as { readonly getTransaction?: unknown } | undefined)?.getTransaction;
				if (typeof fn !== 'function') return undefined;
				return yield* Effect.tryPromise({
					try: () => sui.client.core.getTransaction({ digest }),
					catch: (cause) => cause,
				}).pipe(
					Effect.map(() => ({ digest }) as TransactionInfo),
					Effect.orElseSucceed(() => undefined),
				);
			});

		return { getObject, getObjectStrict, objectsMatchTypes, getTransaction } as const;
	}),
);
