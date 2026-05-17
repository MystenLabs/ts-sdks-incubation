// Manifest emitter — writes `.devstack/manifest.json`. Reads from the
// registries via `gatherManifest()` and the resolved app-extras blob via
// the `Extras` service, then serializes to disk using the idempotent-write
// + chmod pattern.

import { Effect, Schedule, Schema, Scope } from 'effect';
import * as fs from 'node:fs/promises';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	CoinRegistry,
	EndpointRegistry,
	PackageRegistry,
} from '../engine/registries.js';
import { jsonBigintReplacer } from '../engine/json-bigint.js';
import { writeFileAtomicIfChanged } from '../engine/atomic-write.js';
import { ManifestError } from '../engine/errors.js';
import { Extras, resolveExtras } from './extras.js';
import { ManifestV4, type Manifest } from './manifest-schema.js';
import { gatherManifest } from './service.js';

/** Encode the v4 manifest through `Schema.encodeUnknownSync(ManifestV4)`
 *  before serializing. This is a load-bearing guard: a bug in
 *  `gatherManifest` (or any future emitter feeding it) that produces a
 *  shape mismatch with the schema fails HERE at write time, surfacing
 *  the offending field path in the ParseError — instead of silently
 *  writing JSON that `fromManifest`'s downstream consumers then crash
 *  on at read time, far from the bug's origin. */
const encodeManifestV4 = Schema.encodeUnknownSync(ManifestV4);

export interface EmitManifestOptions {
	/** Override the on-disk path. Defaults to
	 *  `.devstack/stacks/<stack>/manifest.json`. */
	readonly output?: string;
	/** Re-snapshot interval. Defaults to 500ms — enough to pick up
	 *  late-registered services without thrashing the disk. */
	readonly tickInterval?: `${number} millis`;
}

const resolveOutputPath = (
	identity: { readonly stack: string },
	override: string | undefined,
): string => override ?? `.devstack/stacks/${identity.stack}/manifest.json`;

/** Write the v4 manifest to disk, idempotently AND atomically. The
 *  atomic-write (tmp + rename) is load-bearing: every reader of
 *  `manifest.json` does a `readFileSync`, which races a
 *  truncate-and-rewrite badly. `rename(2)` is atomic on the same
 *  filesystem so concurrent readers either see the old or the new
 *  content. Skips the rename when the body matches what's already
 *  on disk. Permission 0o600 since the file may carry sensitive extras. */
const writeManifestFile = (
	outputPath: string,
	body: string,
): Effect.Effect<boolean, ManifestError> =>
	Effect.tryPromise({
		try: () => writeFileAtomicIfChanged(outputPath, body, { mode: 0o600 }),
		catch: (cause) =>
			new ManifestError({
				phase: 'write',
				message: `failed to write manifest to ${outputPath}`,
				cause,
			}),
	});

/** Emit a v4 manifest. Eager write at acquire, slow-tick re-snapshot
 *  during the lifetime, final flush on finalize. Returns the eager
 *  snapshot for downstream callers that want to inspect what landed
 *  first. Reads `extras` from the `Extras` service so the value is
 *  shared with codegen's StackHandleEmitter. */
export const emitManifestV4 = (
	options: EmitManifestOptions = {},
): Effect.Effect<
	Manifest,
	ManifestError,
	| PackageRegistry
	| EndpointRegistry
	| AccountRegistry
	| CoinRegistry
	| Identity
	| Extras
	| Scope.Scope
> =>
	Effect.gen(function* () {
		const identity = yield* Identity;
		const outputPath = resolveOutputPath(identity, options.output);

		// Resolve the user's extras Effect ONCE at acquire time, not
		// per-tick. Two reasons:
		//   1. The user's Effect can yield user-defined refs (`yield*
		//      alice`, `yield* openLobby`) — those refs are only
		//      satisfied in the supervisor's acquire scope, not in the
		//      forked slow-tick scope. Yielding them inside the tick
		//      loop fails silently (swallowed by `Effect.ignore({log})`)
		//      and `app.extras` stays `{}` forever.
		//   2. Extras is a one-shot snapshot of post-acquire state by
		//      design — re-running each tick would surface noise from
		//      transient errors during re-evaluation. The state-change
		//      story for `app.extras` is "snapshot + replay on next
		//      `r`", same as the rest of the manifest.
		const extrasInput = yield* Extras;
		const extras = yield* resolveExtras(extrasInput);

		const snapshotAndWrite = Effect.gen(function* () {
			const data = yield* gatherManifest(extras);
			// Encode through the schema BEFORE `JSON.stringify` so a shape
			// mismatch from `gatherManifest` (typo, missing required
			// field, wrong type on a renamed key) surfaces here as a
			// `ManifestError` with the offending field path — not as
			// invalid JSON that crashes downstream consumers far from
			// the bug's origin.
			const encoded = yield* Effect.try({
				try: () => encodeManifestV4(data),
				catch: (cause) =>
					new ManifestError({
						phase: 'write',
						message: `manifest v4 schema encode failed before write to ${outputPath}`,
						cause,
					}),
			});
			const body = JSON.stringify(encoded, jsonBigintReplacer, 2);
			const wrote = yield* writeManifestFile(outputPath, body).pipe(
				Effect.catch((err) =>
					Effect.logWarning(`manifest(v4): ${err.message}`).pipe(
						Effect.annotateLogs({ cause: err.cause }),
						Effect.as(false),
					),
				),
			);
			if (wrote) {
				// `writeFileAtomicIfChanged` already passes `mode: 0o600` for
				// new files, but rename-over-existing keeps the prior file's
				// mode bits. Re-chmod defensively so a manifest file created
				// earlier without the 0o600 mode is tightened next tick.
				yield* Effect.tryPromise(() => fs.chmod(outputPath, 0o600)).pipe(
					Effect.ignore({ log: true }),
				);
			}
			return data;
		});

		// Eager write — dapp-kit reads the manifest at dev-server start.
		const eager = yield* snapshotAndWrite.pipe(Effect.withSpan('manifest-v4.write'));

		// Slow-tick re-snapshot for late registrations (the wallet's
		// endpoint, for example, can land after the manifest factory has
		// already finished its acquire). Forked into the surrounding
		// scope so it tears down with the rest of the stack.
		yield* Effect.forkScoped(
			snapshotAndWrite.pipe(
				Effect.ignore({ log: true }),
				Effect.repeat(Schedule.spaced(options.tickInterval ?? '500 millis')),
				Effect.withSpan('manifest-v4.watch'),
			),
		);

		// Final flush — captures any teardown-time mutations.
		yield* Effect.addFinalizer(() =>
			snapshotAndWrite.pipe(Effect.withSpan('manifest-v4.finalize'), Effect.orDie),
		);

		return eager;
	});
