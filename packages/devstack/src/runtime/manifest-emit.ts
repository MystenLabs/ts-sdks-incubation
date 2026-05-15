// v4 manifest emitter — writes `.devstack/manifest.json` in the v4
// schema. Reads from the same registries as the v3 `manifest()`
// factory (via `gatherManifest()` in `service.ts`), then serializes to
// disk using the same idempotent-write + chmod pattern.
//
// Phase 1 lands this alongside the v3 emitter; nothing calls it yet.
// Phase 2's `Manifest` factory in `services/` calls it. Phase 6 deletes
// the v3 emitter and this becomes the sole writer.

import { Effect, Schedule, Scope } from 'effect';
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
import { ManifestError } from '../primitives/errors.js';
import type { Manifest } from './manifest-schema.js';
import { gatherManifest } from './service.js';

export interface EmitManifestOptions {
	/** Override the on-disk path. Defaults to `.devstack/manifest.json`
	 *  on the `main` stack, `.devstack/stacks/<stack>/manifest.json`
	 *  otherwise. */
	readonly output?: string;
	/** Extras to splice into `app.extras`. Same three-form discriminator
	 *  the v3 `manifest()` factory accepts: plain object, sync function,
	 *  or `Effect`. Sync functions are evaluated once at acquire time;
	 *  Effects are yielded. */
	readonly extras?:
		| Record<string, unknown>
		| (() => Record<string, unknown>)
		| Effect.Effect<Record<string, unknown>, never, never>;
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
 *  yielded. */
const resolveExtras = (
	raw: EmitManifestOptions['extras'],
): Effect.Effect<Record<string, unknown>, never, never> =>
	raw === undefined
		? Effect.succeed({})
		: Effect.isEffect(raw)
			? raw
			: typeof raw === 'function'
				? Effect.sync(raw)
				: Effect.succeed(raw);

/** Write the v4 manifest to disk, idempotently. Skips the write entirely
 *  when the rendered body matches what's already on disk (keeps Vite's
 *  HMR watcher quiet on no-op re-runs). Permission 0o600 since the file
 *  may carry sensitive extras. */
const writeManifestFile = (
	outputPath: string,
	legacyPath: string | undefined,
	body: string,
): Effect.Effect<boolean, ManifestError> =>
	Effect.tryPromise({
		try: async (): Promise<boolean> => {
			let didWrite = false;
			let existing: string | undefined;
			try {
				existing = await fs.readFile(outputPath, 'utf-8');
			} catch {
				// missing — fall through
			}
			if (existing !== body) {
				await fs.mkdir(path.dirname(outputPath), { recursive: true });
				await fs.writeFile(outputPath, body, 'utf-8');
				didWrite = true;
			}
			if (legacyPath !== undefined) {
				let legacyExisting: string | undefined;
				try {
					legacyExisting = await fs.readFile(legacyPath, 'utf-8');
				} catch {
					// missing — fall through
				}
				if (legacyExisting !== body) {
					await fs.mkdir(path.dirname(legacyPath), { recursive: true });
					await fs.writeFile(legacyPath, body, 'utf-8');
					didWrite = true;
				}
			}
			return didWrite;
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
			const body = JSON.stringify(data, jsonBigintReplacer, 2);
			const wrote = yield* writeManifestFile(outputPath, legacyPath, body).pipe(
				Effect.catch((err) =>
					Effect.logWarning(`manifest(v4): ${err.message}`).pipe(
						Effect.annotateLogs({ cause: err.cause }),
						Effect.as(false),
					),
				),
			);
			if (wrote) {
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
