// Regression test for C5: substrate `executeSuiTx` now surfaces
// on-chain `FailedTransaction` as a RETURN-channel variant
// (`$kind: 'FailedTransaction'`) rather than an error-channel
// `SuiExecuteError(phase: 'failed-transaction')`. The seal deploy
// callers MUST dispatch on `$kind` and map FailedTransaction to a
// plugin-shaped `SealError` carrying the digest + execution error.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Option } from 'effect';
import { vi } from 'vitest';

const harness = vi.hoisted(() => ({
	builtBytes: new Uint8Array([0x01, 0x02, 0x03]),
}));

vi.mock('@mysten/sui/transactions', () => ({
	Transaction: class {
		setSender(_address: string): void {}
		moveCall(_input: unknown): unknown {
			return { kind: 'movecall' };
		}
		publish(_input: unknown): unknown {
			return { kind: 'upgradecap' };
		}
		transferObjects(_objects: ReadonlyArray<unknown>, _recipient: string): void {}
		readonly pure = {
			string: (value: string) => ({ kind: 'string', value }),
			u8: (value: number) => ({ kind: 'u8', value }),
			vector: (type: 'u8', value: ReadonlyArray<number>) => ({ kind: 'vector', type, value }),
		};
		build(): Promise<Uint8Array> {
			return Promise.resolve(harness.builtBytes);
		}
	},
}));

import type { AccountValue } from '../../../src/plugins/account/index.ts';
import {
	runRegisterKeyServerTransaction,
	type RegisterKeyServerInputs,
} from '../../../src/plugins/seal/deploy.ts';
import type { ChainProbe } from '../../../src/contracts/chain-probe.ts';
import type { SealObjectProbeKey } from '../../../src/plugins/seal/deploy.ts';

const stubSigner: AccountValue = {
	name: 'publisher',
	address: '0xseal-signer',
	scheme: 'ed25519',
	publicKey: new Uint8Array(32),
	source: 'real',
	funding: { requested: [], applied: [] },
	signAndExecute: () => Effect.die('unused'),
	signTransaction: () => Effect.die('unused'),
	signPersonalMessage: () => Effect.die('unused'),
	withTransactionSigner: (body) =>
		body({
			signTransaction: () => Effect.succeed({ bytes: 'aa', signature: 'sig' }),
			signAndExecute: () => Effect.die('unused'),
		}),
};

const stubChainProbe: ChainProbe<SealObjectProbeKey> = {
	get: () => Effect.die('not used'),
};

const stubSdk = (executeResult: unknown) => ({
	client: {
		core: {
			executeTransaction: async () => executeResult,
			waitForTransaction: async () => undefined,
		},
	} as never,
});

const registerInputs: RegisterKeyServerInputs = {
	name: 'seal',
	chain: 'localnet',
	signer: stubSigner,
	sdk: stubSdk(undefined),
	chainProbe: stubChainProbe,
	keyServerUrl: 'http://seal.local',
	sealPackageId: '0xpkg',
	publicKeyHex: '0x0a0b0c',
	keyServerName: 'devstack-local',
};

describe('seal register — FailedTransaction return dispatch', () => {
	it.effect(
		'maps $kind:"FailedTransaction" to SealError(register) with digest + execution error',
		() =>
			Effect.gen(function* () {
				const sdk = stubSdk({
					$kind: 'FailedTransaction',
					FailedTransaction: {
						digest: '0xbad-register',
						status: { error: 'MoveAbort(seal::register::EBadPubKey, 7)' },
					},
				});
				const exit = yield* Effect.exit(
					runRegisterKeyServerTransaction(sdk, stubSigner, {
						...registerInputs,
						sdk,
					}).pipe(Effect.scoped),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const err = Exit.findErrorOption(exit);
				expect(Option.isSome(err)).toBe(true);
				if (Option.isSome(err)) {
					expect(err.value._tag).toBe('SealError');
					expect(err.value.phase).toBe('register');
					expect(err.value.message).toContain('0xbad-register');
					expect(err.value.message).toContain('MoveAbort');
					expect(err.value.message).toContain('on-chain execution failed');
					// `cause` must NOT carry a SuiExecuteError — FailedTransaction
					// is a return-value, not an upstream error.
					expect(err.value.cause).toBeUndefined();
				}
			}),
	);

	it.effect('still maps transport SuiExecuteError to SealError(register) with phase context', () =>
		Effect.gen(function* () {
			const sdk = {
				client: {
					core: {
						executeTransaction: async () => {
							throw new Error('rpc unreachable');
						},
						waitForTransaction: async () => undefined,
					},
				} as never,
			};
			const exit = yield* Effect.exit(
				runRegisterKeyServerTransaction(sdk, stubSigner, {
					...registerInputs,
					sdk,
				}).pipe(Effect.scoped),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('SealError');
				expect(err.value.phase).toBe('register');
				// Transport failures preserve `cause` (the SuiExecuteError).
				expect(err.value.message).toContain('during execute');
				expect(err.value.message).toContain('rpc unreachable');
			}
		}),
	);
});
