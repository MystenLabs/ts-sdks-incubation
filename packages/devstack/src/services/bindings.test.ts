// Bindings + Codegen plug-in shape. The v4 emitter interface lets
// `Bindings` accept a mixed `Package | KnownPackage` list — packages
// without `sourcePath` are skipped at emit time rather than rejected
// at compose time, so a config that asks for bindings against a
// known-package alongside a local-package compiles fine and produces
// bindings only for the local one.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { tag } from '../advanced/tag.js';
import { Bindings } from './bindings.js';
import { defineEmitter, type Emitter } from '../codegen/define-emitter.js';
import { KnownPackage } from './known-package.js';
import type { LocalPackageShape } from './package.js';

describe('Bindings shape', () => {
	it('accepts a Package | KnownPackage mixed list at compose time', () => {
		const localTag = tag(
			'local',
			Effect.succeed<LocalPackageShape>({
				name: 'local',
				packageId: '0x1',
				upgradeCapId: undefined,
				sourcePath: '/dev/null/move/local',
				mvrPlaceholder: 'local',
				captured: undefined,
			}),
		);
		const knownTag = KnownPackage('known', { packageId: '0x2' });

		// Both refs satisfy the `Package | KnownPackage` constraint on
		// `Bindings.packages`. The emitter silently skips the known one at
		// runtime (no `sourcePath`). Pure type-discipline check — we don't
		// actually need to acquire the resulting tag.
		const ref = Bindings({ packages: [localTag, knownTag], output: './out' });
		expect(ref.key).toBe('codegen/bindings');
	});
});

describe('defineEmitter', () => {
	it('returns an emitter with the supplied name + emit', () => {
		const noop: Emitter = defineEmitter({
			name: 'noop',
			emit: () => Effect.void,
		});
		expect(noop.name).toBe('noop');
	});

	it("packages without sourcePath survive but don't crash the emitter", () => {
		// Type-discipline check: `CodegenPackage.sourcePath` is optional, so
		// an emitter that filters on it must compile even when no entries
		// carry one. (Smoke-test for the filter pattern in BindingsEmitter.)
		const sourceOnly: Emitter = defineEmitter({
			name: 'source-only',
			emit: (ctx) =>
				Effect.gen(function* () {
					const locals = ctx.packages.filter(
						(p): p is import('../codegen/define-emitter.js').CodegenPackage & {
							readonly sourcePath: string;
						} => p.sourcePath !== undefined,
					);
					yield* Effect.log(`source-only: ${locals.length} target(s)`);
				}),
		});
		expect(sourceOnly.name).toBe('source-only');
	});
});

