// Codegen integration test — runs DappKitConfigEmitter + StackHandleEmitter
// end-to-end against a stub manifest, then dynamically imports the emitted
// .ts modules and asserts the exported symbols are present + correctly
// typed. Catches "emitted code doesn't parse" / "missing export" regressions
// that the per-emitter unit tests (which check the body string only) miss.
//
// Path choice (Option D): emits to `src/codegen/emitters/__integration_emitted__/<pid>-<rand>/`
// — a path INSIDE the package source tree so vitest's Vite transform handles
// the .ts → ESM conversion automatically. The dir is gitignored and excluded
// from tsconfig (so stale crash-leftovers don't pollute the build).
// Alternatives considered: Option A (TS compiler API) adds tsc as a runtime
// test dep; Option B (string-shape only) can't catch parse regressions;
// Option C (tmpdir + dynamic import) fails because Vite won't transform
// `.ts` outside its project root.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join as joinPath, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Identity } from '../../engine/identity.js';
import {
	AccountRegistry,
	AccountRegistryLive,
	CoinRegistryLive,
	DeepbookStateRegistryLive,
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
	SealStateRegistryLive,
	SuiStateRegistryLive,
	WalrusStateRegistryLive,
} from '../../engine/registries.js';
import { ExtrasLive } from '../../engine/extras.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import { DappKitConfigEmitter } from './dapp-kit-config.js';
import { StackHandleEmitter } from './stack-handle.js';
import type { CodegenContext } from '../define-emitter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT_ROOT = joinPath(HERE, '__integration_emitted__');

const IdentityLive = Layer.succeed(Identity, {
	app: 'test-app',
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

// Stub manifest — minimal but enough that both emitters produce every
// file they're capable of producing. Sui RPC endpoint (required by
// dapp-kit-config to not skip), one package with mvr + captured (so
// packages.ts has an mvr field and captured.ts has an entry), one
// account (so accounts.ts has a row).
const seedStub = Effect.gen(function* () {
	const eps = yield* EndpointRegistry;
	const pkgs = yield* PackageRegistry;
	const accts = yield* AccountRegistry;
	yield* eps.register({
		name: EndpointName.SUI_RPC,
		url: 'http://sui.test-app.localhost:9000',
		kind: 'rpc',
	});
	yield* pkgs.register({
		name: 'hello',
		packageId: '0xabc',
		mvrPlaceholder: '@local/hello',
		captured: { treasuryCap: '0xcafe' },
	});
	yield* accts.register({ name: 'alice', address: '0x1' });
});

describe('codegen emitters — generated code imports cleanly', () => {
	let outputDir: string;

	beforeEach(() => {
		// Per-worker unique subdir under EMIT_ROOT keeps parallel vitest
		// forks from colliding on file paths. `mkdirSync(recursive)` is
		// a no-op when EMIT_ROOT already exists (e.g. left over from a
		// crashed prior run); mkdtempSync then carves a unique subdir.
		mkdirSync(EMIT_ROOT, { recursive: true });
		outputDir = mkdtempSync(joinPath(EMIT_ROOT, `it-${process.pid}-`));
	});
	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
	});

	const ctx = (): CodegenContext => ({ packages: [], outputDir });

	it.effect('emits dapp-kit-config.ts that imports cleanly and exports the expected config', () =>
		Effect.gen(function* () {
			yield* seedStub;
			// enableBurnerWallet: false avoids pulling in the dev-wallet
			// adapter wiring at module load — the integration test focuses
			// on parse + export shape, not the adapter runtime.
			yield* DappKitConfigEmitter({ enableBurnerWallet: false }).emit(ctx());

			const filePath = joinPath(outputDir, 'dapp-kit-config.ts');
			const mod: Record<string, unknown> = yield* Effect.tryPromise({
				try: () => import(pathToFileURL(filePath).href),
				catch: (cause) => new Error(`failed to import emitted dapp-kit-config: ${String(cause)}`),
			});

			expect(mod.devstackDappKitConfig).toBeDefined();
			const cfg = mod.devstackDappKitConfig as {
				defaultNetwork: unknown;
				networks: ReadonlyArray<unknown>;
				createClient: () => unknown;
				walletInitializers: ReadonlyArray<unknown>;
			};
			expect(cfg.defaultNetwork).toBe('localnet');
			expect(cfg.networks).toEqual(['localnet']);
			expect(typeof cfg.createClient).toBe('function');
			// With enableBurnerWallet:false the adapter is skipped; the
			// emitted module declares `walletInitializers` as `Array<never>`.
			expect(Array.isArray(cfg.walletInitializers)).toBe(true);
			expect(cfg.walletInitializers.length).toBe(0);
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined)))),
	);

	it.effect('emits stack-handle files that import cleanly and export the expected symbols', () =>
		Effect.gen(function* () {
			yield* seedStub;
			yield* StackHandleEmitter().emit(ctx());

			// Verify every file the emitter promises:
			//   accounts.ts → `accounts`, `AccountName` (type — runtime-erased)
			//   services.ts → `services`, `Services` (type — runtime-erased)
			//   extras.ts   → `extras`, `Extras` (type — runtime-erased)
			//   captured.ts → `captured`
			//   packages.ts → `packages`, `PackageName` (type — runtime-erased)
			// We assert the runtime VALUE exports; types disappear after
			// transform and aren't observable from a dynamic import.

			const accounts = (yield* Effect.tryPromise({
				try: () => import(pathToFileURL(joinPath(outputDir, 'accounts.ts')).href),
				catch: (cause) => new Error(`accounts.ts import failed: ${String(cause)}`),
			})) as Record<string, unknown>;
			expect(accounts.accounts).toEqual({ alice: '0x1' });

			const services = (yield* Effect.tryPromise({
				try: () => import(pathToFileURL(joinPath(outputDir, 'services.ts')).href),
				catch: (cause) => new Error(`services.ts import failed: ${String(cause)}`),
			})) as Record<string, unknown>;
			expect(services.services).toBeDefined();
			expect(typeof services.services).toBe('object');
			// Sui rpc is the one service we seeded — assert it round-tripped.
			const svc = services.services as { sui?: { rpc?: { url?: string } } };
			expect(svc.sui?.rpc?.url).toBe('http://sui.test-app.localhost:9000');

			const extras = (yield* Effect.tryPromise({
				try: () => import(pathToFileURL(joinPath(outputDir, 'extras.ts')).href),
				catch: (cause) => new Error(`extras.ts import failed: ${String(cause)}`),
			})) as Record<string, unknown>;
			expect(extras.extras).toEqual({});

			const captured = (yield* Effect.tryPromise({
				try: () => import(pathToFileURL(joinPath(outputDir, 'captured.ts')).href),
				catch: (cause) => new Error(`captured.ts import failed: ${String(cause)}`),
			})) as Record<string, unknown>;
			expect(captured.captured).toEqual({ hello: { treasuryCap: '0xcafe' } });

			const packages = (yield* Effect.tryPromise({
				try: () => import(pathToFileURL(joinPath(outputDir, 'packages.ts')).href),
				catch: (cause) => new Error(`packages.ts import failed: ${String(cause)}`),
			})) as Record<string, unknown>;
			expect(packages.packages).toEqual({
				hello: { id: '0xabc', mvr: '@local/hello' },
			});
		}).pipe(Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined)))),
	);
});
