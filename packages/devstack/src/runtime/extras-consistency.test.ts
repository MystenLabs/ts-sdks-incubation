// `ExtrasResolved` — resolved once at infra-layer build time so every
// downstream consumer sees the SAME record even when the user's input
// is non-pure.
//
// Pre-fix, `manifest-emit.ts` and each codegen emitter independently
// called `resolveExtras(yield* Extras)`. For inputs like
// `() => ({ ts: Date.now() })` or registry-reading Effects, the calls
// returned divergent values across artifacts. This test pins the new
// shape: a single `ExtrasResolved` resolution feeds the manifest, the
// generated `extras.ts`, and any other consumer.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect, Layer, Ref } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { ExtrasLive } from '../engine/extras.js';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistryLive,
	CoinRegistryLive,
	DeepbookStateRegistryLive,
	EndpointRegistryLive,
	PackageRegistryLive,
	SealStateRegistryLive,
	SuiStateRegistryLive,
	WalrusStateRegistryLive,
} from '../engine/registries.js';
import { StackHandleEmitter } from '../codegen/emitters/stack-handle.js';
import type { CodegenContext } from '../codegen/define-emitter.js';
import { emitManifestV4 } from './manifest-emit.js';

const IdentityLive = Layer.succeed(Identity, {
	app: 'extras-test',
	stack: 'main',
	network: 'localnet',
});

const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
	SuiStateRegistryLive,
	SealStateRegistryLive,
	WalrusStateRegistryLive,
	DeepbookStateRegistryLive,
);

describe('ExtrasResolved consistency', () => {
	let outputDir: string;
	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'devstack-extras-consistency-'));
	});
	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
	});

	it.effect('manifest.app.extras and stack-handle extras.ts carry the SAME blob', () =>
		// Build an isolated counter Ref outside the test body and close
		// over it in the extras function. Every call to the function
		// increments + reads — pre-fix, manifest-emit and the codegen
		// emitter each called the function once, getting divergent
		// values (2 vs 3). Post-fix, `ExtrasResolved` is resolved ONCE
		// at infra-layer build time, so both consumers see the SAME
		// snapshot (1) regardless of call order or count.
		Effect.gen(function* () {
			const counter = yield* Ref.make(0);
			const extrasFn = () => {
				// `runSync` against the Ref is safe here: the closure is
				// invoked synchronously from inside the resolver
				// (sync-function branch of `resolveExtras`), and the Ref
				// has no scoped resources.
				const n = Effect.runSync(Ref.updateAndGet(counter, (v) => v + 1));
				return { tick: n };
			};
			const Live = Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(extrasFn));

			// Run both producers in the same Effect.scope — they share
			// the `ExtrasResolved` value via the layer build cache.
			const result = yield* Effect.gen(function* () {
				const manifestPath = joinPath(outputDir, 'manifest.json');
				yield* emitManifestV4({ output: manifestPath });
				const ctx: CodegenContext = { packages: [], outputDir };
				yield* StackHandleEmitter().emit(ctx);

				const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
					app: { extras: { tick: number } };
				};
				const extrasFile = readFileSync(joinPath(outputDir, 'extras.ts'), 'utf-8');
				const observed = yield* Ref.get(counter);
				return { manifest, extrasFile, observed };
			}).pipe(Effect.scoped, Effect.provide(Live));

			// ONE evaluation total (resolved-once at infra build time).
			expect(result.observed).toBe(1);
			expect(result.manifest.app.extras).toEqual({ tick: 1 });
			expect(result.extrasFile).toContain('"tick": 1');
		}),
	);
});
