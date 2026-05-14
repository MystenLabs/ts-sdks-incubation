// Per-source acquisition coverage for `accounts({...})`. The shared
// signing closures (sign/signAndExecute/signPersonalMessage) are
// covered by the integration runs in `examples/wallet` /
// `examples/private-content`; this file exercises the discriminator
// branches in isolation and the matching error paths.
//
// Strategy: bypass `provideDevstack` and yield the per-name tag's own
// `__layer` directly against a hand-rolled base (Engine + Leasing +
// AccountRegistry + a mock `Sui`). For sources that touch the
// filesystem (`'ephemeral-funded'`), we also add a per-test temp
// `StateStoreConfig` so the persisted `.keys/<name>.key` lands under
// `os.tmpdir()` and never near a real `.devstack/`.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Cause, Effect, Exit, Option } from 'effect';
import { Layer } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { encodeSuiPrivateKey, decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { EngineLive } from '../internal/engine.js';
import { AccountRegistryLive } from '../internal/registries.js';
import { LeasingLive } from '../internal/leasing.js';
import { StateStoreConfig } from '../internal/state-store.js';
import { Sui } from '../interfaces/sui.js';
import type { SuiShape } from '../interfaces/sui.js';
import { AccountError, SuiError } from './errors.js';
import { accounts } from './accounts.js';

// Mock Sui — `client` is opaque to the discriminator branches and only
// matters at sign-time, which we don't exercise here. Faucet URL is
// flipped per-test to cover both the available-faucet and no-faucet
// paths. `waitForTransactionsReady` resolves immediately so the
// existing tests don't pay the real ready-probe budget; one dedicated
// test below pins the propagation path when the chain never recovers.
const mockSui = (faucetUrl: string | undefined): Layer.Layer<Sui> =>
	Layer.succeed(Sui, {
		network: 'localnet',
		rpcUrl: 'http://localhost:9000',
		chainId: 'test-chain',
		faucetUrl,
		// The branches under test never call into `client`; cast through
		// unknown so we don't have to wire a real SuiJsonRpcClient up.
		client: {} as unknown as SuiShape['client'],
		waitForTransactionsReady: () => Effect.void,
	});

// `StateStoreConfig` is provided by `defineDevstack`/`provideDevstack`
// in production; tests stand it up directly so `acquireEphemeral` can
// resolve a writable `.keys/` directory under a per-test tmpdir.
const mockStateConfig = (stateDir: string): Layer.Layer<StateStoreConfig> =>
	Layer.succeed(StateStoreConfig, {
		stack: 'test',
		network: 'localnet',
		stateDir,
	});

// Base layer shared by every test. The Sui + StateStoreConfig pieces
// are layered on top per-test because their shapes vary.
const TestBaseLayer = Layer.mergeAll(
	EngineLive,
	NodeFileSystemLayer,
	AccountRegistryLive,
	LeasingLive,
);

const mkTmpDir = (label: string) =>
	Effect.tryPromise({
		try: () => nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), `devstack-accounts-${label}-`)),
		catch: (cause) => new Error(`failed to create tmpdir: ${String(cause)}`),
	}).pipe(Effect.orDie);

describe('accounts({...}) — source discriminator', () => {
	it.effect('bare `{}` form resolves to ephemeral-funded shape', () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('legacy');
			// Stub the faucet so the `ephemeral-funded` branch's HTTP call
			// against `${faucetUrl}/v2/gas` returns 200 OK and the
			// acquire-phase succeeds without a real localnet.
			const restore = stubFaucet();
			try {
				const a = accounts({ alice: {} });
				const alice = yield* Effect.gen(function* () {
					return yield* a.alice;
				}).pipe(
					Effect.provide(
						Layer.provide(
							a.alice.__layer,
							Layer.mergeAll(
								TestBaseLayer,
								mockSui('http://localhost:9123'),
								mockStateConfig(tmpdir),
							),
						),
					),
				);
				expect(alice.address.startsWith('0x')).toBe(true);
				expect(alice.scheme).toBe('ED25519');
			} finally {
				restore();
			}
		}),
	);

	it.effect("explicit from: 'ephemeral-funded' matches the bare form", () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('explicit');
			const restore = stubFaucet();
			try {
				const a = accounts({ bob: { from: 'ephemeral-funded' } });
				const bob = yield* Effect.gen(function* () {
					return yield* a.bob;
				}).pipe(
					Effect.provide(
						Layer.provide(
							a.bob.__layer,
							Layer.mergeAll(
								TestBaseLayer,
								mockSui('http://localhost:9123'),
								mockStateConfig(tmpdir),
							),
						),
					),
				);
				expect(bob.address.startsWith('0x')).toBe(true);
				// Warm-start: re-yielding the SAME tag (new acquisition) under
				// the same stateDir should recover the persisted address.
				const bob2 = yield* Effect.gen(function* () {
					return yield* a.bob;
				}).pipe(
					Effect.provide(
						Layer.provide(
							a.bob.__layer,
							Layer.mergeAll(
								TestBaseLayer,
								mockSui('http://localhost:9123'),
								mockStateConfig(tmpdir),
							),
						),
					),
				);
				expect(bob2.address).toBe(bob.address);
			} finally {
				restore();
			}
		}),
	);

	it.effect("from: 'inline' loads a literal suiprivkey", () =>
		Effect.gen(function* () {
			// Generate a known keypair off-stack so the test can assert
			// address equality without relying on RNG.
			const kp = Ed25519Keypair.generate();
			const expectedAddress = kp.getPublicKey().toSuiAddress();
			const bech32 = encodeSuiPrivateKey(
				decodeSuiPrivateKey(kp.getSecretKey()).secretKey,
				'ED25519',
			);

			const a = accounts({ guest: { from: 'inline', privateKey: bech32 } });
			const guest = yield* Effect.gen(function* () {
				return yield* a.guest;
			}).pipe(
				Effect.provide(
					Layer.provide(a.guest.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
			);
			expect(guest.address).toBe(expectedAddress);
			expect(guest.scheme).toBe('ED25519');
		}),
	);

	it.effect("from: 'inline' carries through scheme for Secp256k1", () =>
		Effect.gen(function* () {
			const kp = Secp256k1Keypair.generate();
			const expectedAddress = kp.getPublicKey().toSuiAddress();
			const bech32 = encodeSuiPrivateKey(
				decodeSuiPrivateKey(kp.getSecretKey()).secretKey,
				'Secp256k1',
			);
			const a = accounts({ oracle: { from: 'inline', privateKey: bech32 } });
			const oracle = yield* Effect.gen(function* () {
				return yield* a.oracle;
			}).pipe(
				Effect.provide(
					Layer.provide(a.oracle.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
			);
			expect(oracle.address).toBe(expectedAddress);
			expect(oracle.scheme).toBe('Secp256k1');
		}),
	);

	it.effect("from: 'env' reads process.env[key]", () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const bech32 = encodeSuiPrivateKey(
				decodeSuiPrivateKey(kp.getSecretKey()).secretKey,
				'ED25519',
			);
			const expectedAddress = kp.getPublicKey().toSuiAddress();
			const envKey = 'DEVSTACK_TEST_ENV_KEY';
			process.env[envKey] = bech32;
			try {
				const a = accounts({ ci: { from: 'env', key: envKey } });
				const ci = yield* Effect.gen(function* () {
					return yield* a.ci;
				}).pipe(
					Effect.provide(
						Layer.provide(a.ci.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
					),
				);
				expect(ci.address).toBe(expectedAddress);
			} finally {
				delete process.env[envKey];
			}
		}),
	);

	it.effect("from: 'env' fails AccountError when the env var is missing", () =>
		Effect.gen(function* () {
			const envKey = 'DEVSTACK_TEST_MISSING_ENV';
			delete process.env[envKey];
			const a = accounts({ ci: { from: 'env', key: envKey } });
			const exit = yield* Effect.gen(function* () {
				return yield* a.ci;
			}).pipe(
				Effect.provide(
					Layer.provide(a.ci.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
				Effect.exit,
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const err = extractError(exit);
				expect(err).toBeInstanceOf(AccountError);
				expect(err?.phase).toBe('load-key');
				expect(err?.message).toMatch(/env var/);
			}
		}),
	);

	it.effect(
		"from: 'ephemeral-funded' surfaces AccountError(fund) when waitForTransactionsReady fails",
		() =>
			Effect.gen(function* () {
				const tmpdir = yield* mkTmpDir('wait-fails');
				// Custom Sui mock whose `waitForTransactionsReady` fails so
				// we exercise the propagation path that gates the faucet
				// POST loop. Without this guard, the account would
				// rediscover the same dead chain via its own retry budget.
				const mockSuiWithFailingReady: Layer.Layer<Sui> = Layer.succeed(Sui, {
					network: 'localnet',
					rpcUrl: 'http://localhost:9000',
					chainId: 'test-chain',
					faucetUrl: 'http://localhost:9123',
					client: {} as unknown as SuiShape['client'],
					waitForTransactionsReady: () =>
						Effect.fail(
							new SuiError({
								phase: 'wait-for-transactions-ready',
								message: 'chain never became funds-transferable',
							}),
						),
				});
				const a = accounts({ alice: { from: 'ephemeral-funded' } });
				const exit = yield* Effect.gen(function* () {
					return yield* a.alice;
				}).pipe(
					Effect.provide(
						Layer.provide(
							a.alice.__layer,
							Layer.mergeAll(TestBaseLayer, mockSuiWithFailingReady, mockStateConfig(tmpdir)),
						),
					),
					Effect.exit,
				);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					const err = extractError(exit);
					expect(err).toBeInstanceOf(AccountError);
					expect(err?.phase).toBe('fund');
					// The wrapping message must surface the underlying
					// SuiError text so the user sees why the wait failed.
					expect(err?.message).toMatch(/funds-transferable/);
				}
			}),
	);

	it.effect("from: 'ephemeral-funded' fails AccountError when Sui has no faucetUrl", () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('nofaucet');
			const a = accounts({ alice: { from: 'ephemeral-funded' } });
			const exit = yield* Effect.gen(function* () {
				return yield* a.alice;
			}).pipe(
				Effect.provide(
					Layer.provide(
						a.alice.__layer,
						Layer.mergeAll(TestBaseLayer, mockSui(undefined), mockStateConfig(tmpdir)),
					),
				),
				Effect.exit,
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const err = extractError(exit);
				expect(err).toBeInstanceOf(AccountError);
				expect(err?.phase).toBe('fund');
				expect(err?.message).toMatch(/faucet/i);
			}
		}),
	);
});

// Test helpers --------------------------------------------------------------

// Pull the typed AccountError out of an `Exit.Failure`. The layer
// wrapping in `provideTag` puts the failure under a non-trivial Cause
// tree (engine lifecycle, scope finalizers); `Cause.findErrorOption`
// returns the underlying typed value regardless of where it landed.
const extractError = (exit: Exit.Exit<unknown, unknown>): AccountError | undefined => {
	if (!Exit.isFailure(exit)) return undefined;
	const cause = (exit as unknown as { cause: Cause.Cause<unknown> }).cause;
	const opt = Cause.findErrorOption(cause);
	if (Option.isNone(opt)) return undefined;
	return opt.value instanceof AccountError ? opt.value : undefined;
};

// Patch global `fetch` with a stub that pretends every request to the
// `${faucetUrl}/v2/gas` endpoint returns 200 OK. Returns a `restore`
// function that puts the original back. Used by tests that exercise
// `ephemeral-funded` so we don't depend on a real localnet faucet.
const stubFaucet = (): (() => void) => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
};
