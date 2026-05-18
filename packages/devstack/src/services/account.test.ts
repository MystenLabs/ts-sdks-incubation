// Per-source acquisition coverage for `Account(name, opts?)`. The
// shared signing closures (sign / signAndExecute / signPersonalMessage)
// are covered by the integration runs in `examples/wallet` /
// `examples/private-content`; this file exercises the discriminator
// branches in isolation and the matching error paths.
//
// Strategy: bypass the supervisor and yield the per-name Ref's own
// `__layer` directly against a hand-rolled base (Engine + Leasing +
// AccountRegistry + a mock `SuiTag`). For sources that touch the
// filesystem (`'ephemeral-funded'`), we also add a per-test temp
// `StateStoreConfig` so the persisted `.keys/<name>.key` lands under
// `os.tmpdir()` and never near a real `.devstack/`.

import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { layer as NodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { encodeSuiPrivateKey, decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { EngineLive } from '../engine/engine.js';
import { AccountRegistryLive } from '../engine/registries.js';
import { LeasingLive } from '../engine/leasing.js';
import { StateStoreConfig } from '../engine/state-store.js';
import { SuiTag, type Sui } from './sui.js';
import { AccountError, SuiError } from '../engine/errors.js';
import { Account } from './account.js';
import { FaucetTag, type Faucet } from './faucet/index.js';

// Mock SuiTag — `client` is opaque to the discriminator branches and
// only matters at sign-time, which we don't exercise here. Faucet URL
// is flipped per-test to cover both the available-faucet and no-faucet
// paths. `waitForTransactionsReady` resolves immediately so the existing
// tests don't pay the real ready-probe budget; one dedicated test below
// pins the propagation path when the chain never recovers.
const mockSui = (faucetUrl: string | undefined): Layer.Layer<SuiTag> =>
	Layer.succeed(SuiTag, {
		network: 'localnet',
		rpc: { host: 'http://localhost:9000' },
		chainId: 'test-chain',
		faucet: faucetUrl !== undefined ? { host: faucetUrl } : undefined,
		// The branches under test never call into `client`; cast through
		// unknown so we don't have to wire a real SuiJsonRpcClient up.
		client: {} as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
		runtime: 'bundled',
	});

// `StateStoreConfig` is provided by the supervisor in production; tests
// stand it up directly so `acquireEphemeral` can resolve a writable
// `.keys/` directory under a per-test tmpdir.
const mockStateConfig = (stateDir: string): Layer.Layer<StateStoreConfig> =>
	Layer.succeed(StateStoreConfig, {
		stack: 'test',
		network: 'localnet',
		stateDir,
	});

// Base layer shared by every test. The SuiTag + StateStoreConfig pieces
// are layered on top per-test because their shapes vary.
const TestBaseLayer = Layer.mergeAll(
	EngineLive,
	NodeFileSystemLayer,
	AccountRegistryLive,
	LeasingLive,
);

const mkTmpDir = (label: string) =>
	Effect.tryPromise({
		try: () => nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), `devstack-account-${label}-`)),
		catch: (cause) => new Error(`failed to create tmpdir: ${String(cause)}`),
	}).pipe(Effect.orDie);

describe('Account(name, opts?) — source discriminator', () => {
	it.effect('bare `Account(name)` resolves to ephemeral-funded shape', () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('legacy');
			// Stub the faucet so the `ephemeral-funded` branch's HTTP call
			// against `${faucetUrl}/v2/gas` returns 200 OK and the
			// acquire-phase succeeds without a real localnet.
			const restore = stubFaucet();
			try {
				const alice = Account('alice');
				const resolved = yield* Effect.gen(function* () {
					return yield* alice;
				}).pipe(
					Effect.provide(
						Layer.provide(
							alice.__layer,
							Layer.mergeAll(
								TestBaseLayer,
								mockSui('http://localhost:9123'),
								mockStateConfig(tmpdir),
							),
						),
					),
				);
				expect(resolved.address.startsWith('0x')).toBe(true);
				expect(resolved.scheme).toBe('ed25519');
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
				const bob = Account('bob', { from: 'ephemeral-funded' });
				const resolved = yield* Effect.gen(function* () {
					return yield* bob;
				}).pipe(
					Effect.provide(
						Layer.provide(
							bob.__layer,
							Layer.mergeAll(
								TestBaseLayer,
								mockSui('http://localhost:9123'),
								mockStateConfig(tmpdir),
							),
						),
					),
				);
				expect(resolved.address.startsWith('0x')).toBe(true);
				// Warm-start: re-yielding the SAME Ref (new acquisition) under
				// the same stateDir should recover the persisted address.
				const bob2 = Account('bob', { from: 'ephemeral-funded' });
				const resolved2 = yield* Effect.gen(function* () {
					return yield* bob2;
				}).pipe(
					Effect.provide(
						Layer.provide(
							bob2.__layer,
							Layer.mergeAll(
								TestBaseLayer,
								mockSui('http://localhost:9123'),
								mockStateConfig(tmpdir),
							),
						),
					),
				);
				expect(resolved2.address).toBe(resolved.address);
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

			const guest = Account('guest', { from: 'inline', privateKey: bech32 });
			const resolved = yield* Effect.gen(function* () {
				return yield* guest;
			}).pipe(
				Effect.provide(
					Layer.provide(guest.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
			);
			expect(resolved.address).toBe(expectedAddress);
			expect(resolved.scheme).toBe('ed25519');
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
			const oracle = Account('oracle', { from: 'inline', privateKey: bech32 });
			const resolved = yield* Effect.gen(function* () {
				return yield* oracle;
			}).pipe(
				Effect.provide(
					Layer.provide(oracle.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
			);
			expect(resolved.address).toBe(expectedAddress);
			expect(resolved.scheme).toBe('secp256k1');
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
				const ci = Account('ci', { from: 'env', key: envKey });
				const resolved = yield* Effect.gen(function* () {
					return yield* ci;
				}).pipe(
					Effect.provide(
						Layer.provide(ci.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
					),
				);
				expect(resolved.address).toBe(expectedAddress);
			} finally {
				delete process.env[envKey];
			}
		}),
	);

	it.effect("from: 'signer' uses the supplied Signer directly", () =>
		Effect.gen(function* () {
			// A real Keypair satisfies the Signer interface; using one here
			// keeps the test independent of any HSM/remote-signer fixture
			// while exercising the same code path.
			const kp = Ed25519Keypair.generate();
			const ext = Account('ext', { from: 'signer', signer: kp });
			const resolved = yield* Effect.gen(function* () {
				return yield* ext;
			}).pipe(
				Effect.provide(
					Layer.provide(ext.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
			);
			expect(resolved.address).toBe(kp.getPublicKey().toSuiAddress());
			// Mirrors the inline/env paths: scheme is whatever
			// `getKeyScheme()` returns — `ED25519` here, not a lowercased
			// projection.
			expect(resolved.scheme).toBe('ed25519');
		}),
	);

	it.effect("from: 'signer' honors a caller-supplied address override", () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const override = '0xdeadbeef';
			const ext = Account('ext-pinned', { from: 'signer', signer: kp, address: override });
			const resolved = yield* Effect.gen(function* () {
				return yield* ext;
			}).pipe(
				Effect.provide(
					Layer.provide(ext.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
				),
			);
			expect(resolved.address).toBe(override);
		}),
	);

	it.effect('funding spec dispatches each entry through Faucet.requestCoin', () =>
		Effect.gen(function* () {
			// Stand up a Faucet with a recording-fake strategy. The body
			// drains the recorded calls to confirm Account threaded the
			// declared funding through `requestCoin`.
			const calls: Array<{ coinType: string; address: string; amount: bigint }> = [];
			const FaucetWithRecording: Layer.Layer<FaucetTag> = Layer.effect(
				FaucetTag,
				Effect.sync(
					(): Faucet => ({
						register: () => Effect.void,
						requestCoin: (coinType, address, amount) =>
							Effect.sync(() => {
								calls.push({ coinType, address, amount });
							}),
						listFundable: Effect.succeed([] as ReadonlyArray<string>),
					}),
				),
			);
			const kp = Ed25519Keypair.generate();
			const expectedAddress = kp.getPublicKey().toSuiAddress();
			const a = Account('funded', {
				from: 'signer',
				signer: kp,
				funding: { SUI: 100n, WAL: 50n },
			});
			yield* Effect.gen(function* () {
				return yield* a;
			}).pipe(
				Effect.provide(
					Layer.provide(
						a.__layer,
						Layer.mergeAll(TestBaseLayer, mockSui(undefined), FaucetWithRecording),
					),
				),
			);
			expect(calls).toEqual([
				{ coinType: 'SUI', address: expectedAddress, amount: 100n },
				{ coinType: 'WAL', address: expectedAddress, amount: 50n },
			]);
		}),
	);

	it.effect("from: 'env' fails AccountError when the env var is missing", () =>
		Effect.gen(function* () {
			const envKey = 'DEVSTACK_TEST_MISSING_ENV';
			delete process.env[envKey];
			const ci = Account('ci', { from: 'env', key: envKey });
			const exit = yield* Effect.gen(function* () {
				return yield* ci;
			}).pipe(
				Effect.provide(
					Layer.provide(ci.__layer, Layer.mergeAll(TestBaseLayer, mockSui(undefined))),
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
				// Custom SuiTag mock whose `waitForTransactionsReady` fails so
				// we exercise the propagation path that gates the faucet POST
				// loop. Without this guard, the account would rediscover the
				// same dead chain via its own retry budget.
				const mockSuiWithFailingReady: Layer.Layer<SuiTag> = Layer.succeed(SuiTag, {
					network: 'localnet',
					rpc: { host: 'http://localhost:9000' },
					chainId: 'test-chain',
					faucet: { host: 'http://localhost:9123' },
					client: {} as unknown as Sui['client'],
					waitForTransactionsReady: () =>
						Effect.fail(
							new SuiError({
								phase: 'wait-for-transactions-ready',
								message: 'chain never became funds-transferable',
							}),
						),
					runtime: 'bundled',
				});
				const alice = Account('alice', { from: 'ephemeral-funded' });
				const exit = yield* Effect.gen(function* () {
					return yield* alice;
				}).pipe(
					Effect.provide(
						Layer.provide(
							alice.__layer,
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
					// The wrapping message must surface the underlying SuiError
					// text so the user sees why the wait failed.
					expect(err?.message).toMatch(/funds-transferable/);
				}
			}),
	);

	it.effect("from: 'ephemeral-funded' fails AccountError when Sui has no faucetUrl", () =>
		Effect.gen(function* () {
			const tmpdir = yield* mkTmpDir('nofaucet');
			const alice = Account('alice', { from: 'ephemeral-funded' });
			const exit = yield* Effect.gen(function* () {
				return yield* alice;
			}).pipe(
				Effect.provide(
					Layer.provide(
						alice.__layer,
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

// Pull the typed AccountError out of an `Exit.Failure`. The layer wrapping
// in `tag` puts the failure under a non-trivial Cause tree (engine
// lifecycle, scope finalizers); `Cause.findErrorOption` returns the
// underlying typed value regardless of where it landed.
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
