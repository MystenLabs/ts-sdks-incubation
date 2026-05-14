// Coverage for the `extras` overload discriminator in `manifest({...})`.
// The factory accepts a plain object, a sync function, or an
// `Effect.Effect`; the runtime body discriminates at acquire time and
// the resolved value lands at `manifest.extras` (and gets written to
// disk under `output`).
//
// We yield each manifest tag's __layer directly so the test stands the
// in-memory registries up itself and the on-disk write hits a per-test
// tmpdir.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../internal/engine.js';
import {
	AccountRegistryLive,
	CoinRegistryLive,
	EndpointRegistryLive,
	PackageRegistryLive,
} from '../internal/registries.js';
import { manifest } from './manifest.js';

const TestBaseLayer = Layer.mergeAll(
	EngineLive,
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
);

const mkTmpManifestPath = (label: string) =>
	Effect.tryPromise({
		try: async () => {
			const dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), `devstack-manifest-${label}-`));
			return nodePath.join(dir, 'manifest.json');
		},
		catch: (cause) => new Error(`failed to create tmpdir: ${String(cause)}`),
	}).pipe(Effect.orDie);

const readWritten = (path: string) =>
	Effect.tryPromise({
		try: () => nodeFs.readFile(path, 'utf-8'),
		catch: (cause) => new Error(`failed to read manifest: ${String(cause)}`),
	}).pipe(Effect.orDie);

describe('manifest({ extras }) discriminator', () => {
	it.effect('plain object is stored verbatim', () =>
		Effect.gen(function* () {
			const output = yield* mkTmpManifestPath('plain');
			const tag = manifest({ extras: { foo: 'bar' }, output });
			const value = yield* Effect.gen(function* () {
				return yield* tag;
			}).pipe(Effect.scoped, Effect.provide(Layer.provide(tag.__layer, TestBaseLayer)));
			expect(value.extras).toEqual({ foo: 'bar' });
			// Acquire write is eager — the file should land before the scope
			// closes (the finalizer flush is a separate pass).
			const body = JSON.parse(yield* readWritten(output)) as { extras: Record<string, unknown> };
			expect(body.extras).toEqual({ foo: 'bar' });
		}),
	);

	it.effect('sync function is invoked once and its return merged', () =>
		Effect.gen(function* () {
			const output = yield* mkTmpManifestPath('sync');
			let invocations = 0;
			const tag = manifest({
				extras: () => {
					invocations += 1;
					return { x: 1 };
				},
				output,
			});
			const value = yield* Effect.gen(function* () {
				return yield* tag;
			}).pipe(Effect.scoped, Effect.provide(Layer.provide(tag.__layer, TestBaseLayer)));
			expect(value.extras).toEqual({ x: 1 });
			// Acquire + scope finalizer both call the resolve function via
			// `snapshotAndWrite`. The discriminator should evaluate the
			// caller's function exactly once at the top of acquire — the
			// finalizer reuses the resolved `extras` value.
			expect(invocations).toBe(1);
		}),
	);

	it.effect('Effect is yielded and the resolved value merged', () =>
		Effect.gen(function* () {
			const output = yield* mkTmpManifestPath('effect');
			const tag = manifest({ extras: Effect.succeed({ y: 2 }), output });
			const value = yield* Effect.gen(function* () {
				return yield* tag;
			}).pipe(Effect.scoped, Effect.provide(Layer.provide(tag.__layer, TestBaseLayer)));
			expect(value.extras).toEqual({ y: 2 });
		}),
	);

	it.effect('undefined extras lands as the empty record', () =>
		Effect.gen(function* () {
			const output = yield* mkTmpManifestPath('absent');
			const tag = manifest({ output });
			const value = yield* Effect.gen(function* () {
				return yield* tag;
			}).pipe(Effect.scoped, Effect.provide(Layer.provide(tag.__layer, TestBaseLayer)));
			expect(value.extras).toEqual({});
		}),
	);
});
