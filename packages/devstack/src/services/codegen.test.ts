// Codegen shape. With no `emitters` field, Codegen defaults to
// `[BindingsEmitter()]` (Move → TS bindings via `@mysten/codegen`),
// which is what 90% of stacks want; mixed `Package | KnownPackage`
// lists compose at type-check time and the bindings emitter silently
// skips KnownPackage entries (no `sourcePath`) at runtime.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { EngineLive } from '../engine/engine.js';
import { tag } from '../advanced/tag.js';
import { Codegen } from './codegen.js';
import { defineEmitter, type Emitter } from '../codegen/define-emitter.js';
import { KnownPackage } from './known-package.js';
import type { LocalPackage } from './package.js';

describe('Codegen shape', () => {
	it('accepts a Package | KnownPackage mixed list at compose time', () => {
		const localTag = tag(
			'local',
			Effect.succeed<LocalPackage>({
				name: 'local',
				packageId: '0x1',
				upgradeCapId: undefined,
				sourcePath: '/dev/null/move/local',
				mvrPlaceholder: 'local',
				captured: undefined,
			}),
		);
		const knownTag = KnownPackage('known', { packageId: '0x2' });

		// No `emitters` field — Codegen defaults to BindingsEmitter().
		// Both refs satisfy the `Package | KnownPackage` constraint on
		// `packages`. The emitter silently skips the known one at
		// runtime (no `sourcePath`). Pure type-discipline check — we don't
		// actually need to acquire the resulting tag.
		const ref = Codegen({ packages: [localTag, knownTag], output: './out' });
		expect(ref.key).toBe('codegen/codegen');
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
						(
							p,
						): p is import('../codegen/define-emitter.js').CodegenPackage & {
							readonly sourcePath: string;
						} => p.sourcePath !== undefined,
					);
					yield* Effect.log(`source-only: ${locals.length} target(s)`);
				}),
		});
		expect(sourceOnly.name).toBe('source-only');
	});
});

describe('Codegen .gitignore', () => {
	let outputDir: string;
	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'devstack-codegen-gitignore-'));
	});
	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
	});

	const buildCodegen = (overrideOutput?: string) => {
		const ref = Codegen({ output: overrideOutput ?? outputDir, emitters: [] });
		return Layer.build(ref.__layer).pipe(Effect.scoped, Effect.provide(EngineLive));
	};

	it.effect('drops a .gitignore covering dapp-kit-config.ts and extras.ts', () =>
		Effect.gen(function* () {
			yield* buildCodegen();
			const gitignorePath = joinPath(outputDir, '.gitignore');
			expect(existsSync(gitignorePath)).toBe(true);
			const body = readFileSync(gitignorePath, 'utf-8');
			expect(body).toContain('dapp-kit-config.ts');
			expect(body).toContain('extras.ts');
			expect(body).toContain('@mysten-incubation/devstack');
		}),
	);

	it.effect('leaves an existing user-customized .gitignore alone', () =>
		Effect.gen(function* () {
			const gitignorePath = joinPath(outputDir, '.gitignore');
			const userBody = '# my custom ignores\nfoo.ts\nbar/\n';
			writeFileSync(gitignorePath, userBody, 'utf-8');

			yield* buildCodegen();

			// User content is preserved verbatim — devstack must not stomp
			// a hand-edited ignore file even if it's missing the entries
			// the default would have added.
			expect(readFileSync(gitignorePath, 'utf-8')).toBe(userBody);
		}),
	);
});
