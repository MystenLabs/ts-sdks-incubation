// Phase 3 P3.T8 — `DappKitConfigEmitter` translates the devstack
// `*-fork` network literal to the stripped upstream form on emit,
// while baking the unstripped literal + a `runtime: 'forked' | 'normal'`
// constant alongside so consumers (fork-aware UI, dev-wallet badge)
// can branch on them.
//
// D1 in `notes/sui-fork-integration.md` is the contract: dapp-kit must
// see `'mainnet'` (not `'mainnet-fork'`) so `getChainIdentifier`
// validation against the wrapped chain's real chainId passes.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Identity } from '../../engine/identity.js';
import {
	AccountRegistry,
	AccountRegistryLive,
	CoinRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookStateRegistryLive,
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
	PostgresStateRegistryLive,
	PythStateRegistryLive,
	SealStateRegistryLive,
	SuiStateRegistryLive,
	WalrusStateRegistryLive,
} from '../../engine/registries.js';
import { ExtrasLive } from '../../engine/extras.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import { DappKitConfigEmitter } from './dapp-kit-config.js';
import type { CodegenContext } from '../define-emitter.js';

const RegistriesLive = Layer.mergeAll(
	PackageRegistryLive,
	EndpointRegistryLive,
	AccountRegistryLive,
	CoinRegistryLive,
	SuiStateRegistryLive,
	SealStateRegistryLive,
	WalrusStateRegistryLive,
	DeepbookStateRegistryLive,
	PythStateRegistryLive,
	PostgresStateRegistryLive,
	DeepbookIndexerStateRegistryLive,
	DeepbookServerStateRegistryLive,
	DeepbookMarginStateRegistryLive,
);

const seedSuiRpc = (network: string) =>
	Effect.gen(function* () {
		const eps = yield* EndpointRegistry;
		yield* eps.register({
			name: EndpointName.SUI_RPC,
			url: `http://sui.test-app.localhost:50051`,
			kind: 'rpc',
		});
		// Empty packages + accounts — the network translation contract
		// doesn't depend on either; keep the test focused.
		void (yield* PackageRegistry);
		void (yield* AccountRegistry);
		void network;
	});

const IdentityFor = (network: 'mainnet-fork' | 'testnet-fork' | 'devnet-fork' | 'mainnet') =>
	Layer.succeed(Identity, {
		app: 'test-app',
		stack: 'main',
		network,
	});

describe('Phase 3 P3.T8 — DappKitConfigEmitter fork-network translation', () => {
	let outputDir: string;
	beforeEach(() => {
		outputDir = mkdtempSync(joinPath(tmpdir(), 'devstack-dapp-kit-config-fork-'));
	});
	afterEach(() => {
		rmSync(outputDir, { recursive: true, force: true });
	});

	const ctx = (): CodegenContext => ({ packages: [], outputDir });

	it.effect('emits stripped `network` for mainnet-fork and bakes `runtime: "forked"`', () =>
		Effect.gen(function* () {
			yield* seedSuiRpc('mainnet-fork');
			yield* DappKitConfigEmitter().emit(ctx());

			const body = readFileSync(joinPath(outputDir, 'dapp-kit-config.ts'), 'utf-8');
			// dapp-kit consumes `network` — must be the stripped form so
			// `getChainIdentifier` validation against the real mainnet
			// chainId passes.
			expect(body).toContain('const network = "mainnet" as const');
			// The unstripped form lives in `devstackNetwork` for fork-aware
			// consumers (dev-wallet badge, app-level fork UI).
			expect(body).toContain('export const devstackNetwork = "mainnet-fork" as const');
			// `runtime` is the structured signal — self-describing for
			// downstream consumers.
			expect(body).toContain('export const runtime = "forked" as const');
			// And `networks: [network]` reflects the stripped form, so
			// dapp-kit's network list dialog (and the wallet's network list
			// derived from it) sees `'mainnet'`.
			expect(body).toContain('networks: [network] as [typeof network]');
		}).pipe(
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityFor('mainnet-fork'), ExtrasLive(undefined))),
		),
	);

	it.effect('emits stripped `network` for testnet-fork', () =>
		Effect.gen(function* () {
			yield* seedSuiRpc('testnet-fork');
			yield* DappKitConfigEmitter().emit(ctx());

			const body = readFileSync(joinPath(outputDir, 'dapp-kit-config.ts'), 'utf-8');
			expect(body).toContain('const network = "testnet" as const');
			expect(body).toContain('export const devstackNetwork = "testnet-fork" as const');
			expect(body).toContain('export const runtime = "forked" as const');
		}).pipe(
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityFor('testnet-fork'), ExtrasLive(undefined))),
		),
	);

	it.effect('emits stripped `network` for devnet-fork', () =>
		Effect.gen(function* () {
			yield* seedSuiRpc('devnet-fork');
			yield* DappKitConfigEmitter().emit(ctx());

			const body = readFileSync(joinPath(outputDir, 'dapp-kit-config.ts'), 'utf-8');
			expect(body).toContain('const network = "devnet" as const');
			expect(body).toContain('export const devstackNetwork = "devnet-fork" as const');
			expect(body).toContain('export const runtime = "forked" as const');
		}).pipe(
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityFor('devnet-fork'), ExtrasLive(undefined))),
		),
	);

	it.effect('passes non-fork networks through unchanged with `runtime: "normal"`', () =>
		Effect.gen(function* () {
			yield* seedSuiRpc('mainnet');
			yield* DappKitConfigEmitter().emit(ctx());

			const body = readFileSync(joinPath(outputDir, 'dapp-kit-config.ts'), 'utf-8');
			// No translation needed: stripped and devstackNetwork agree.
			expect(body).toContain('const network = "mainnet" as const');
			expect(body).toContain('export const devstackNetwork = "mainnet" as const');
			expect(body).toContain('export const runtime = "normal" as const');
		}).pipe(
			Effect.provide(Layer.mergeAll(RegistriesLive, IdentityFor('mainnet'), ExtrasLive(undefined))),
		),
	);
});
