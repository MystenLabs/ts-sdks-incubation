// Action plugin — typed BuildContext exposed to the user's body +
// discriminator callbacks.
//
// Mirrors the substrate's `BuildContext<Provided>` shape but adds
// action-specific surfaces (resolved Sui client, `tx(build)` helper,
// `signAndExecute(account, build)` helper). The context is constructed
// in `index.ts`'s acquire body and threaded into both:
//
//   - `opts.body(ctx)` — the user's main action Effect.
//   - `opts.discriminator(ctx)` — optional callback that derives the
//      cache-key discriminator from upstream resolved values (see
//      `discriminator.ts`).

import type { Effect, Scope } from 'effect';

import type { Transaction } from '@mysten/sui/transactions';

import type { AnyMember } from '../../substrate/plugin.ts';
import type { AnyTag, ResolvedOf, TagIdOf } from '../../substrate/tag.ts';
import type { __MemberNotConsumedError } from '../../substrate/plugin.ts';
import type { AccountValue } from '../account/service.ts';
import type { SuiClient } from '../sui/index.ts';

import type { ActionError } from './errors.ts';
import type { ActionReceipt } from './service.ts';

/** Build-time context handed to the user's `body` callback (and the
 *  optional `discriminator` callback).
 *
 *  Carries:
 *
 *   - typed `get(tag)` — over the upstream-tag union derived from
 *     `consumes`; cleanly reduces when the consumes tuple is concrete.
 *   - typed `use(member)` — preserves the member's literal-typed
 *     `provides` generic; the substrate's `__MemberNotConsumedError`
 *     fires at the call site if the member isn't in `Consumes`.
 *   - `sui` — the resolved `SuiClient` (sdk shim + chain id + opaque
 *     `client` for `Transaction.build({client})`). Threaded eagerly
 *     because SuiTag is always part of the action's hard upstream.
 *   - `tx(build, opts?)` — low-level helper that allocates a
 *     `Transaction`, lets the user populate it, and serialises to
 *     raw bytes. Use this if you need the raw bytes (e.g. to drive a
 *     custom signing surface).
 *   - `signAndExecute(account, build)` — high-level helper. Drives
 *     the full build → sign → execute → wait → project pipeline
 *     against the supplied account, returning a parsed
 *     `ActionReceipt`. Folds the SDK boundary cast +
 *     `include: {effects, objectTypes}` execute + finality wait +
 *     envelope projection into a single call. Errors surface as
 *     `ActionError` (phase `sign` for transport / RPC failures;
 *     `parse` for envelope-shape failures). */
export interface ActionBuildContext<Consumes extends ReadonlyArray<AnyTag>> {
	readonly get: <T extends Consumes[number]>(tag: T) => ResolvedOf<T>;
	readonly use: <M extends AnyMember>(
		member: M &
			(TagIdOf<M['provides']> extends TagIdOf<Consumes[number]>
				? unknown
				: __MemberNotConsumedError<TagIdOf<M['provides']>>),
	) => ResolvedOf<M['provides']>;
	/** Resolved SuiClient. SuiTag is part of action's hard upstream so
	 *  this is always populated. */
	readonly sui: SuiClient;
	/** Low-level: allocate a Transaction, let the caller populate it
	 *  (moveCall / transferObjects / etc.), then serialise to bytes.
	 *  Sets the sender if `opts.sender` is provided (typically the
	 *  signing account's address). Catches serialisation throws and
	 *  wraps them as `ActionError({phase:'sign'})`. */
	readonly tx: (
		build: (tx: Transaction) => void,
		opts?: { readonly sender?: string },
	) => Effect.Effect<Uint8Array, ActionError>;
	/** High-level: build + sign + execute + wait + project the
	 *  transaction in one call. The `account` is the signer (typically
	 *  pulled from `ctx.use(<accountRef>)`). The `build` callback
	 *  populates the fresh `Transaction`; the sender is set
	 *  automatically to `account.address`. Returns a parsed
	 *  `ActionReceipt` whose `objectChanges` array is non-empty when
	 *  the transaction created or mutated on-chain objects (the SDK is
	 *  invoked with `include: { effects, objectTypes }`). */
	readonly signAndExecute: (
		account: AccountValue,
		build: (tx: Transaction) => void,
	) => Effect.Effect<ActionReceipt, ActionError, Scope.Scope>;
}
