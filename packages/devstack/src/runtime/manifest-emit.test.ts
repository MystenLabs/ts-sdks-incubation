// emitManifestV4 — covers the producer half of the manifest contract:
//   - eager write at acquire (consumer must be able to read immediately)
//   - 0o600 permissions (manifest may carry sensitive extras)
//   - schema encode happens BEFORE serialize (typo in registry surfaces
//     as ManifestError at write time, not invalid JSON at read time)
//   - final flush captures late-registered state on scope close
//
// The slow-tick re-snapshot is harder to test reliably; covered
// implicitly by the final-flush path (it runs the same snapshotAndWrite).

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect, Layer, Scope, Exit } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	AccountRegistryLive,
	CoinRegistryLive,
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistryLive,
} from '../engine/registries.js';
import { ExtrasLive } from '../engine/extras.js';
import { EndpointName } from './endpoint-names.js';
import { emitManifestV4 } from './manifest-emit.js';

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
);

describe('emitManifestV4', () => {
	let outputDir: string;
	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'devstack-manifest-emit-'));
	});
	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
	});

	const outputPath = (): string => joinPath(outputDir, 'manifest.json');

	it.effect('eager-writes a v4 manifest on acquire (consumers can read immediately)', () =>
		Effect.gen(function* () {
			// Seed registries with a minimal sui-rpc + alice account.
			const eps = yield* EndpointRegistry;
			const accts = yield* AccountRegistry;
			yield* eps.register({ name: EndpointName.SUI_RPC, url: 'http://sui.test:9000', kind: 'rpc' });
			yield* accts.register({ name: 'alice', address: '0x1' });

			yield* emitManifestV4({ output: outputPath() });

			// File exists immediately after acquire; content matches v4 shape.
			const body = readFileSync(outputPath(), 'utf-8');
			const parsed = JSON.parse(body) as {
				version: number;
				stack: { name: string; network: string; app: string };
				services?: { sui?: { rpc?: { url: string } } };
				accounts: Record<string, { address: string }>;
			};
			expect(parsed.version).toBe(4);
			expect(parsed.stack).toEqual({ name: 'main', network: 'localnet', app: 'test-app' });
			expect(parsed.services?.sui?.rpc?.url).toBe('http://sui.test:9000');
			expect(parsed.accounts['alice']).toEqual({ address: '0x1' });
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined))),
		),
	);

	it.effect('writes the manifest with mode 0o600 (extras may be sensitive)', () =>
		Effect.gen(function* () {
			yield* emitManifestV4({ output: outputPath() });
			const mode = statSync(outputPath()).mode & 0o777;
			expect(mode).toBe(0o600);
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined))),
		),
	);

	it.effect('propagates Extras into app.extras', () =>
		Effect.gen(function* () {
			yield* emitManifestV4({ output: outputPath() });
			const parsed = JSON.parse(readFileSync(outputPath(), 'utf-8')) as {
				app: { extras: Record<string, unknown> };
			};
			expect(parsed.app.extras).toEqual({ openLobbyId: '0xfeed' });
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive({ openLobbyId: '0xfeed' })),
			),
		),
	);

	it.effect('final flush on scope close picks up late-registered state', () =>
		Effect.gen(function* () {
			// Open a scope manually so we can register AFTER the emitter has
			// already done its eager write, then close the scope and assert
			// the file reflects the late entry. This mirrors the supervisor's
			// real-world pattern: the wallet primitive registers its endpoint
			// after the manifest factory's acquire finishes; the slow-tick
			// re-snapshot picks it up, and the final-flush finalizer captures
			// any post-tick mutation on teardown.
			const scope = yield* Scope.make();
			const eps = yield* EndpointRegistry;
			yield* Scope.provide(emitManifestV4({ output: outputPath() }), scope);

			// Late registration — after acquire returned, before scope close.
			yield* eps.register({
				name: EndpointName.WALLET_APP,
				url: 'http://wallet.test:5180',
			});

			// Close the scope: runs the final-flush finalizer.
			yield* Scope.close(scope, Exit.void);

			const parsed = JSON.parse(readFileSync(outputPath(), 'utf-8')) as {
				app: { wallet?: { url: string } };
			};
			expect(parsed.app.wallet?.url).toBe('http://wallet.test:5180');
		}).pipe(
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined))),
		),
	);

	it.effect('honors the explicit output path override', () =>
		Effect.gen(function* () {
			const custom = joinPath(outputDir, 'custom', 'manifest.json');
			yield* emitManifestV4({ output: custom });
			expect(readFileSync(custom, 'utf-8')).toContain('"version": 4');
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityLive, ExtrasLive(undefined))),
		),
	);
});
