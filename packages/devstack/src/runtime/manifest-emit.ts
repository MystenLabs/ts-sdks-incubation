// v4 manifest emitter — writes `.devstack/manifest.json` in the v4
// schema. Reads from the same registries as the v3 `manifest()`
// factory (via `gatherManifest()` in `service.ts`), then serializes to
// disk using the same idempotent-write + chmod pattern.
//
// Phase 1 lands this alongside the v3 emitter; nothing calls it yet.
// Phase 2's `Manifest` factory in `services/` calls it. Phase 6 deletes
// the v3 emitter and this becomes the sole writer.

import { Effect, Schedule, Schema, Scope } from 'effect';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
	/** Override the on-disk path. Defaults to `.devstack/manifest.json`
	 *  on the `main` stack, `.devstack/stacks/<stack>/manifest.json`
	 *  otherwise. */
	readonly output?: string;
	/** Extras to splice into `app.extras`. Same three-form discriminator
	 *  the v3 `manifest()` factory accepts: plain object, sync function,
	 *  or `Effect`. Sync functions are evaluated once at acquire time;
	 *  Effects are yielded — the Effect runs in the gather-manifest scope
	 *  where every stack Ref / tag is already in context, so the R channel
	 *  is `any`: yield whichever Refs / tag classes you composed with
	 *  `devstack(...)` (e.g. `yield* SealKeyServerTag`, `yield* alice`).
	 *  Missing services surface as Effect's ServiceNotFound at runtime. */
	readonly extras?:
		| Record<string, unknown>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		| (() => Record<string, unknown> | Effect.Effect<Record<string, unknown>, any, any>)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		| Effect.Effect<Record<string, unknown>, any, any>;
	/** Interval at which to re-snapshot during the stack's lifetime.
	 *  v3 uses 500ms; keep the same default for parity. */
	readonly tickInterval?: `${number} millis`;
}

const resolveOutputPath = (
	identity: { readonly stack: string },
	override: string | undefined,
): string => {
	if (override !== undefined) return override;
	return identity.stack === 'main'
		? '.devstack/manifest.json'
		: `.devstack/stacks/${identity.stack}/manifest.json`;
};

/** Resolve the optional legacy `.devstack/manifest.json` path that
 *  non-main stacks ALSO write to, for vite's hardcoded import resolution
 *  in example apps. Matches v3's two-path write behavior. */
const resolveLegacyPath = (outputPath: string): string | undefined => {
	const isMainStack = outputPath.endsWith(path.join('.devstack', 'manifest.json'));
	if (isMainStack) return undefined;
	return path.join(path.dirname(path.dirname(path.dirname(outputPath))), 'manifest.json');
};

/** Resolve `extras` from one of the three accepted shapes. Plain
 *  object → returned as-is. Sync function → called once. Effect →
 *  yielded. R is `any` because the user's Effect can yield any tag
 *  in stack scope (e.g. `SealKeyServerTag`, an `Account` ref) — the
 *  caller (`emitManifestV4`) runs this inside the gather-manifest
 *  scope where every stack service is already provided. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveExtras = (
	raw: EmitManifestOptions['extras'],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Effect.Effect<Record<string, unknown>, any, any> =>
	raw === undefined
		? Effect.succeed({})
		: Effect.isEffect(raw)
			? raw
			: typeof raw === 'function'
				? (() => {
						const v = raw();
						return Effect.isEffect(v) ? v : Effect.succeed(v);
					})()
				: Effect.succeed(raw);

/** Write the v4 manifest to disk, idempotently AND atomically. The
 *  atomic-write (tmp + rename) is the load-bearing piece: every
 *  reader of `manifest.json` (`fromManifest`, `playwright/web-server`,
 *  `dapp-kit`) does a synchronous `readFileSync`, which races a
 *  truncate-and-rewrite badly — a mid-write read yields an empty or
 *  partial buffer that fails `JSON.parse`. `rename(2)` is atomic on
 *  the same filesystem, so concurrent readers either see the old or
 *  the new content. Skips the rename when the body matches what's
 *  already on disk (keeps Vite's HMR watcher quiet on no-op re-runs).
 *  Permission 0o600 since the file may carry sensitive extras. */
const writeManifestFile = (
	outputPath: string,
	legacyPath: string | undefined,
	body: string,
): Effect.Effect<boolean, ManifestError> =>
	Effect.tryPromise({
		try: async (): Promise<boolean> => {
			const wroteCanonical = await writeFileAtomicIfChanged(outputPath, body, { mode: 0o600 });
			let wroteLegacy = false;
			if (legacyPath !== undefined) {
				wroteLegacy = await writeFileAtomicIfChanged(legacyPath, body, { mode: 0o600 });
			}
			return wroteCanonical || wroteLegacy;
		},
		catch: (cause) =>
			new ManifestError({
				phase: 'write',
				message: `failed to write manifest to ${outputPath}`,
				cause,
			}),
	});

/** Emit a v4 manifest. Eager write at acquire, slow-tick re-snapshot
 *  during the lifetime, final flush on finalize. Same behavior as v3
 *  `manifest()` but writes the new schema. Returns the eager snapshot
 *  for downstream callers that want to inspect what landed first.
 *
 *  This is an Effect rather than a factory because it'll be invoked by
 *  the Phase-2 `Manifest` factory and used directly by `devstack(...)`
 *  for the auto-implicit-manifest case. */
export const emitManifestV4 = (
	options: EmitManifestOptions = {},
): Effect.Effect<
	Manifest,
	ManifestError,
	PackageRegistry | EndpointRegistry | AccountRegistry | CoinRegistry | Identity | Scope.Scope
> =>
	Effect.gen(function* () {
		const identity = yield* Identity;
		const outputPath = resolveOutputPath(identity, options.output);
		const legacyPath = resolveLegacyPath(outputPath);
		const extras = yield* resolveExtras(options.extras);

		const snapshotAndWrite = Effect.gen(function* () {
			const data = yield* gatherManifest(extras);
			// Encode through the schema BEFORE `JSON.stringify` so a shape
			// mismatch from `gatherManifest` (typo, missing required
			// field, wrong type on a renamed key) surfaces here as a
			// `ManifestError` with the offending field path — not as
			// invalid JSON that crashes `fromManifest`'s consumers downstream.
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
			const wrote = yield* writeManifestFile(outputPath, legacyPath, body).pipe(
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
				// mode bits. Re-chmod both paths defensively so a manifest
				// file created earlier without the 0o600 mode is tightened
				// next tick.
				yield* Effect.tryPromise(() => fs.chmod(outputPath, 0o600)).pipe(
					Effect.ignore({ log: true }),
				);
				if (legacyPath !== undefined) {
					yield* Effect.tryPromise(() => fs.chmod(legacyPath, 0o600)).pipe(
						Effect.ignore({ log: true }),
					);
				}
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
