// Shared tagged errors for the runtime persistence layer.
//
// Per-subsystem tags so `Effect.catchTags({ ... })` reads at the call
// site as "what did the cache / registry just fail with".

import { Schema } from 'effect';

/** Atomic-write failure — one tag covers every stage. The `stage`
 *  field discriminates inside renderer messages without
 *  proliferating tag types. */
export class AtomicWriteFailed extends Schema.TaggedErrorClass<AtomicWriteFailed>()(
	'AtomicWriteFailed',
	{
		path: Schema.String,
		stage: Schema.Literals(['mkdir-parent', 'open-temp', 'write', 'fsync', 'rename', 'encode']),
		cause: Schema.optional(Schema.Defect),
	},
) {}

/** Cache surface — same tri-state as the L0 cache contract. */
export class CacheError extends Schema.TaggedErrorClass<CacheError>()('CacheError', {
	reason: Schema.Literals(['io-failed', 'corruption', 'lock-contention']),
	detail: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

/** Strategy registry missing-key surface. Canonical tagged error
 *  yielded from `StrategyRegistry.get` when no contributor is
 *  registered under the requested capability key. The
 *  `contracts/strategy-contributor.ts` `StrategyRegistry` interface
 *  imports this class as its `E` channel — one `_tag` literal,
 *  one class, package-wide. */
export class StrategyNotFoundError extends Schema.TaggedErrorClass<StrategyNotFoundError>()(
	'StrategyNotFoundError',
	{
		capabilityKey: Schema.String,
		registeredKeys: Schema.Array(Schema.String),
	},
) {}

/** Port-broker allocation failure — surfaced when no free port could be
 *  found in the configured range, when a caller-supplied `preferredPort`
 *  is already taken by another in-process allocation, or when the bind-
 *  probe rejected every candidate.
 *
 *  `reason` discriminates the failure mode for renderer mapping:
 *    - `no-free-port`  : scanned the whole window for `kind`, every
 *                        candidate failed the bind-probe (EADDRINUSE) or
 *                        was already held by a sibling allocation in
 *                        this process.
 *    - `preferred-busy`: caller supplied a `preferredPort` and the
 *                        port is currently held by another in-process
 *                        allocation (refused per architecture §6).
 *    - `bind-probe-failed`: the OS-level bind probe surfaced an error
 *                          OTHER than `EADDRINUSE` (e.g. EACCES on a
 *                          privileged port, EPERM under jail). Caller
 *                          should fall back to user opt-in / docs.
 *    - `reservation-failed`: the runtime-root scoped port reservation
 *                            file could not be created/read/reclaimed. */
export class PortBrokerError extends Schema.TaggedErrorClass<PortBrokerError>()('PortBrokerError', {
	reason: Schema.Literals([
		'no-free-port',
		'preferred-busy',
		'bind-probe-failed',
		'reservation-failed',
	]),
	detail: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}
