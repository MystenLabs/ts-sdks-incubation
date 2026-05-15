// DappKitEmitter — output-shape coverage. The emitter renders a TS
// file the consumer app imports; we exercise the renderer against
// a synthetic CodegenContext and assert byte-stable output.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Effect, Layer } from 'effect';
import { describe, expect, it, afterEach } from '@effect/vitest';
import { DappKitEmitter } from './dapp-kit.js';
import type { CodegenContext } from '../define-emitter.js';

let tempDirs: Array<string> = [];

afterEach(async () => {
	for (const d of tempDirs) {
		await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
	}
	tempDirs = [];
});

const mkTmpDir = async (label: string): Promise<string> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `devstack-dapp-kit-${label}-`));
	tempDirs.push(dir);
	return dir;
};

describe('DappKitEmitter', () => {
	it.effect('emits a TS file at <output>/dapp-kit/index.ts', () =>
		Effect.gen(function* () {
			const tmp = yield* Effect.promise(() => mkTmpDir('emit'));
			const ctx: CodegenContext = {
				packages: [
					{ name: 'hello', packageId: '0xaaa', mvrPlaceholder: '@local/hello' },
					{ name: 'world', packageId: '0xbbb', mvrPlaceholder: '@local/world' },
				],
				outputDir: tmp,
			};
			const emitter = DappKitEmitter();
			yield* emitter.emit(ctx).pipe(Effect.provide(Layer.empty));
			const emitted = yield* Effect.promise(() =>
				fs.readFile(path.join(tmp, 'dapp-kit', 'index.ts'), 'utf-8'),
			);
			expect(emitted).toContain("from '@mysten/dapp-kit-core'");
			// Default flavor is react — the Register declaration block should be present.
			expect(emitted).toContain("declare module '@mysten/dapp-kit-react'");
			// MVR overrides should be sorted alphabetically and contain the
			// supplied placeholders mapped to package ids.
			expect(emitted).toContain('"@local/hello": "0xaaa"');
			expect(emitted).toContain('"@local/world": "0xbbb"');
		}),
	);

	it.effect("'core' flavor omits the React Register block", () =>
		Effect.gen(function* () {
			const tmp = yield* Effect.promise(() => mkTmpDir('core'));
			const ctx: CodegenContext = { packages: [], outputDir: tmp };
			const emitter = DappKitEmitter({ flavor: 'core' });
			yield* emitter.emit(ctx).pipe(Effect.provide(Layer.empty));
			const emitted = yield* Effect.promise(() =>
				fs.readFile(path.join(tmp, 'dapp-kit', 'index.ts'), 'utf-8'),
			);
			expect(emitted).not.toContain('@mysten/dapp-kit-react');
			expect(emitted).toContain("from '@mysten/dapp-kit-core'");
		}),
	);

	it.effect('re-emit produces byte-identical output for the same context', () =>
		Effect.gen(function* () {
			const tmp = yield* Effect.promise(() => mkTmpDir('stable'));
			const ctx: CodegenContext = {
				packages: [{ name: 'hello', packageId: '0xaaa', mvrPlaceholder: '@local/hello' }],
				outputDir: tmp,
			};
			const emitter = DappKitEmitter();
			yield* emitter.emit(ctx).pipe(Effect.provide(Layer.empty));
			const filePath = path.join(tmp, 'dapp-kit', 'index.ts');
			const firstBytes = yield* Effect.promise(() => fs.readFile(filePath, 'utf-8'));
			yield* emitter.emit(ctx).pipe(Effect.provide(Layer.empty));
			const secondBytes = yield* Effect.promise(() => fs.readFile(filePath, 'utf-8'));
			expect(secondBytes).toBe(firstBytes);
		}),
	);
});
