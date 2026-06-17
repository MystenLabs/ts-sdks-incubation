import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { withTempRootAsync } from '../../helpers/with-temp-root.ts';
import { makeTestPluginCtx } from '../../helpers/test-plugin-ctx.ts';

import {
	account,
	fundingProjectionForResult,
	type AccountRegistryEntry,
} from '../../../src/plugins/account/index.ts';
import { makeAccountRegistryContribution } from '../../../src/plugins/account/registry.ts';
import { emitContributions } from '../../../src/substrate/plugin-ctx.ts';
import { coin } from '../../../src/plugins/coin/index.ts';
import { DEEPBOOK_TESTNET_DEEP_COIN_TYPE, deepbook } from '../../../src/plugins/deepbook/index.ts';
import {
	acquireAccount,
	type AccountAcquireContext,
	type AccountValue,
	validateAccountName,
} from '../../../src/plugins/account/service.ts';
import { resolveEphemeralVariant } from '../../../src/plugins/account/variants/ephemeral.ts';
import { resolveSignerVariant } from '../../../src/plugins/account/variants/signer.ts';
import { layerLeaseBroker } from '../../../src/substrate/runtime/lease-broker/index.ts';
import { layerStrategyRegistry } from '../../../src/substrate/runtime/strategy-registry/index.ts';

const fakeResolvedAccount = {
	name: 'alice',
	address: '0xabc',
	scheme: 'ed25519',
	publicKey: new Uint8Array(),
	source: 'real',
	funding: {
		requested: [{ coin: 'SUI', fullCoinType: '0x2::sui::SUI', amount: 1_000_000_000n }],
		applied: [
			{
				coin: 'SUI',
				fullCoinType: '0x2::sui::SUI',
				amount: 1_000_000_000n,
				outcome: 'funded',
			},
		],
	},
	signAndExecute: null,
	withTransactionSigner: null,
	signTransaction: null,
	signPersonalMessage: null,
} as unknown as AccountValue;

// Account emits its contributions INLINE from `start` via the typed `ctx`
// verbs. The funding projection asserted here flows through the registry
// strategy-contributor decl: `start` builds a `realEntry` whose `funding`
// is `fundingProjectionForResult(resolved.funding)`, then feeds
// `makeAccountRegistryContribution(realEntry)` into the shared
// `emitContributions` router. This helper rebuilds that exact decl from a
// resolved value and reads the `account:`-keyed contribution back out of a
// decl-capturing fake ctx — exactly the projection `start` emits.
//
// `member` is still constructed via `account(...)` at every call site (so
// name-validation + the factory body still run); its `id` (`account/<name>`)
// supplies the literal account name for the resolved value.
const registryFundingFor = (
	member: ReturnType<typeof account>,
	funding: AccountValue['funding'] = fakeResolvedAccount.funding,
) => {
	const name = member.id.slice('account/'.length);
	const resolved = { ...fakeResolvedAccount, name, funding } as AccountValue;
	const realEntry: AccountRegistryEntry = {
		name,
		address: resolved.address,
		scheme: resolved.scheme,
		source: resolved.source,
		funding: fundingProjectionForResult(resolved.funding),
	};
	const { ctx, captured } = makeTestPluginCtx();
	emitContributions(ctx, [
		makeAccountRegistryContribution(realEntry as AccountRegistryEntry & { readonly name: string }),
	]);
	const registry = captured.provides.find(
		(decl) => decl.capabilityKey.startsWith('account:') && 'funding' in (decl.strategy as object),
	);
	if (registry === undefined) throw new Error('missing account registry contribution');
	return (registry.strategy as AccountRegistryEntry).funding;
};

describe('account name validation', () => {
	it('accepts generated TypeScript identifier-safe names, including camelCase', () => {
		expect(Effect.runSync(validateAccountName('pythPublisher'))).toBeUndefined();
		expect(Effect.runSync(validateAccountName('seal_publisher'))).toBeUndefined();
	});

	it('rejects names that are path-safe but not generated export-safe', async () => {
		const exit = await Effect.runPromiseExit(validateAccountName('pyth-publisher'));

		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value.message).toContain('pyth-publisher');
			expect(err.value.hint).toContain('underscores');
		}
		expect(() => account('pyth-publisher')).toThrow(TypeError);
		expect(() => account('pyth.publisher')).toThrow(TypeError);
	});

	it('rejects generated export reserved words', async () => {
		const exit = await Effect.runPromiseExit(validateAccountName('class'));

		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.findErrorOption(exit);
		expect(Option.isSome(err)).toBe(true);
		if (Option.isSome(err)) {
			expect(err.value.message).toContain('reserved word');
		}
		expect(() => account('class')).toThrow(TypeError);
	});
});

describe('account signer variant surface', () => {
	it('binds a provided keypair — address + scheme come from the signer', async () => {
		// The `signer` variant is the single bring-your-own door. A secret
		// loaded from an env var or an inline `suiprivkey1...` literal is
		// expressed by constructing the keypair yourself and passing it as
		// the signer, e.g.
		//   account('ci', { kind: 'signer', signer:
		//     Ed25519Keypair.fromSecretKey(process.env.ALICE_PRIVATE_KEY!) })
		const keypair = Ed25519Keypair.generate();

		const resolved = await Effect.runPromise(resolveSignerVariant({ name: 'ci', signer: keypair }));

		expect(resolved.address).toBe(keypair.toSuiAddress());
		expect(resolved.scheme).toBe('ed25519');
		// The signer door never fishes the secret out of the supplied signer.
		expect(resolved.bech32Secret).toBeNull();
	});

	it('honors the addressOverride for signers whose address is memoized', async () => {
		const keypair = Ed25519Keypair.generate();
		const override = keypair.toSuiAddress();

		const resolved = await Effect.runPromise(
			resolveSignerVariant({ name: 'demo', signer: keypair, addressOverride: override }),
		);

		expect(resolved.address).toBe(override);
	});

	it('account factory accepts the signer option', () => {
		const signerAccount = account('prod', {
			kind: 'signer',
			signer: Ed25519Keypair.generate(),
		});

		expect(signerAccount.id).toBe('account/prod');
	});

	it('projects default ephemeral funding into account registry capabilities', () => {
		expect(registryFundingFor(account('alice'))).toEqual({
			status: 'funded',
			balanceMist: null,
			requestedMist: '1000000000',
			entries: [
				{
					coin: 'SUI',
					fullCoinType: '0x2::sui::SUI',
					amount: '1000000000',
					status: 'funded',
				},
			],
		});
	});

	it('projects explicit empty funding as skipped', () => {
		expect(
			registryFundingFor(account('alice', { kind: 'ephemeral', funding: [] }), {
				requested: [],
				applied: [],
			}),
		).toEqual({
			status: 'skipped',
			balanceMist: null,
			requestedMist: null,
			entries: [],
		});
	});

	it('projects non-ephemeral accounts without funding as skipped', () => {
		expect(
			registryFundingFor(account('alice', { kind: 'signer', signer: Ed25519Keypair.generate() }), {
				requested: [],
				applied: [],
			}),
		).toEqual({
			status: 'skipped',
			balanceMist: null,
			requestedMist: null,
			entries: [],
		});
	});

	it('threads funding coin and strategy provider refs into dependencies', () => {
		const deep = coin.known(DEEPBOOK_TESTNET_DEEP_COIN_TYPE);
		const dex = deepbook({ mode: 'known', network: 'testnet' });
		const member = account('alice', {
			kind: 'ephemeral',
			funding: [
				{ coin: 'sui', amount: 1_000_000_000n },
				{ coin: deep, amount: 15_000_000n, via: dex },
			],
		});

		expect(member.dependsOn.map((dependency) => dependency.id)).toEqual(['sui', deep.id, dex.id]);
	});

	it('declares input identity for default and explicit funding', () => {
		const deep = coin.known(DEEPBOOK_TESTNET_DEEP_COIN_TYPE);
		const dex = deepbook({ mode: 'known', network: 'testnet' });

		expect(account('alice').inputIdentity).toEqual({
			kind: 'static',
			value: {
				plugin: 'account',
				name: 'alice',
				variant: { kind: 'ephemeral' },
				funding: [{ coin: 'sui', amountMist: '1000000000' }],
			},
		});
		expect(account('alice', { kind: 'ephemeral', funding: [] }).inputIdentity).toEqual({
			kind: 'static',
			value: {
				plugin: 'account',
				name: 'alice',
				variant: { kind: 'ephemeral' },
				funding: [],
			},
		});
		expect(
			account('alice', {
				kind: 'ephemeral',
				funding: [
					{ coin: 'sui', amount: 10_000_000_000n },
					{ coin: deep, amount: 15_000_000n, via: dex },
				],
			}).inputIdentity,
		).toEqual({
			kind: 'static',
			value: {
				plugin: 'account',
				name: 'alice',
				variant: { kind: 'ephemeral' },
				funding: [
					{ coin: 'sui', amountMist: '10000000000' },
					{ coin: deep.id, amountMist: '15000000', via: [dex.id] },
				],
			},
		});
	});

	it('declares signer identity in input identity', () => {
		const signer = Ed25519Keypair.generate();

		expect(account('prod', { kind: 'signer', signer }).inputIdentity).toEqual({
			kind: 'static',
			value: {
				plugin: 'account',
				name: 'prod',
				variant: { kind: 'signer', address: signer.toSuiAddress() },
				funding: [],
			},
		});
	});
});

describe('account impersonation variant', () => {
	it('executes through the fork impersonation surface and still refuses direct signing', async () => {
		const calls: string[] = [];
		const address = '0xaaaa';
		const raw = {
			$kind: 'Transaction',
			Transaction: {
				digest: 'fork-digest',
				effects: {
					changedObjects: [
						{
							objectId: '0xcreated',
							outputState: 'ObjectWrite',
							idOperation: 'Created',
						},
					],
				},
				objectTypes: {
					'0xcreated': '0xpkg::demo::Created',
				},
			},
		};
		const ctx: AccountAcquireContext = {
			sui: {
				mode: 'fork',
				chainId: 'sui:mainnet-fork',
				sdk: {
					core: {
						getObject: () => Promise.reject(new Error('unused')),
						getTransaction: () => Promise.reject(new Error('unused')),
						getBalance: () => Promise.reject(new Error('unused')),
						listCoins: () => Promise.reject(new Error('unused')),
						executeTransaction: () => Promise.reject(new Error('unused')),
						waitForTransaction: async ({ digest }) => {
							calls.push(`wait:${digest}`);
							return {};
						},
					},
					client: null as never,
				},
				fork: {
					status: Effect.succeed({ checkpoint: '1', clock: 1 }),
					advanceClock: () => Effect.void,
					advanceCheckpoint: Effect.void,
					impersonate: (sender, tx) =>
						Effect.sync(() => {
							calls.push(`impersonate:${sender}:${(tx as Uint8Array)[0]}`);
							return { digest: 'fork-digest', success: true, raw };
						}),
				},
			},
			runtimeRoot: '/tmp/devstack-account-impersonate-test',
			app: 'test-app',
			stack: 'test-stack',
			emitAutoPromotionEvent: () => Effect.void,
			projectedFunding: [],
		};

		const accountValue = await Effect.runPromise(
			acquireAccount({ kind: 'impersonate', name: 'whale', address, funding: [] }, ctx).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.provide(layerLeaseBroker),
			),
		);
		const result = await Effect.runPromise(accountValue.signAndExecute(new Uint8Array([7])));
		const signExit = await Effect.runPromiseExit(accountValue.signTransaction(new Uint8Array([7])));

		expect(result.$kind).toBe('Transaction');
		if (result.$kind !== 'Transaction') throw new Error('expected Transaction variant');
		expect(result.Transaction.digest).toBe('fork-digest');
		expect(result.Transaction.objectChanges).toEqual([
			{
				type: 'created',
				objectId: '0xcreated',
				objectType: '0xpkg::demo::Created',
				outputState: 'ObjectWrite',
				idOperation: 'Created',
			},
		]);
		expect(calls).toEqual([`impersonate:${address}:7`, 'wait:fork-digest']);
		expect(Exit.isFailure(signExit)).toBe(true);
	});
});

describe('account ephemeral variant persistence', () => {
	it('reuses the persisted keypair on warm start', () =>
		withTempRootAsync('devstack-account-ephemeral', async (root) => {
			const secretFilePath = join(root, 'account', 'alice.key');

			const first = await Effect.runPromise(
				resolveEphemeralVariant({ name: 'alice', secretFilePath }),
			);
			const second = await Effect.runPromise(
				resolveEphemeralVariant({ name: 'alice', secretFilePath }),
			);

			expect(second.address).toBe(first.address);
			expect(readFileSync(secretFilePath, 'utf8').trim()).toBe(first.bech32Secret);
			expect(statSync(secretFilePath).mode & 0o777).toBe(0o600);
			expect(statSync(join(root, 'account')).mode & 0o777).toBe(0o700);
		}));

	it('collapses concurrent first acquires onto one persisted keypair', () =>
		withTempRootAsync('devstack-account-ephemeral-race', async (root) => {
			const secretFilePath = join(root, 'account', 'alice.key');

			const [first, second] = await Effect.runPromise(
				Effect.all(
					[
						resolveEphemeralVariant({ name: 'alice', secretFilePath }),
						resolveEphemeralVariant({ name: 'alice', secretFilePath }),
					],
					{ concurrency: 2 },
				),
			);

			expect(second.address).toBe(first.address);
			expect(readFileSync(secretFilePath, 'utf8').trim()).toBe(first.bech32Secret);
		}));
});
