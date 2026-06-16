// Wallet acquire-boot regression tests.
//
// Duplicate-address guard (service.ts step 1): two accounts resolving to
// the same address would silently last-write-wins the address-keyed sign
// map, so a sign request for that address would bind to a non-
// deterministic account. The fix fails boot with a `bind-account`
// `walletBootError` naming the colliding address. These tests pin that
// failure AND the single-distinct-address happy path.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';

import type { AccountValue } from '../../../src/plugins/account/service.ts';
import { WALLET_ACCOUNTS_ALL } from '../../../src/plugins/wallet/index.ts';
import { acquireWallet, type WalletAcquireContext } from '../../../src/plugins/wallet/service.ts';

const makeAccount = (name: string, address: string): AccountValue =>
	({
		name,
		address,
		scheme: 'ed25519',
		publicKey: new Uint8Array(),
		source: 'real',
		funding: { requested: [], applied: [] },
		signAndExecute: () => Effect.die('not reached'),
		withTransactionSigner: () => Effect.die('not reached'),
		signTransaction: () => Effect.die('not reached'),
		signPersonalMessage: () => Effect.die('not reached'),
	}) as unknown as AccountValue;

const makeCtx = (
	stateRoot: string,
	accounts: ReadonlyArray<AccountValue>,
): WalletAcquireContext => ({
	app: 'app',
	stack: 'main',
	network: 'localnet',
	stateRoot,
	allocatePort: () => Effect.succeed(0),
	resolveAccounts: () => Effect.succeed(accounts),
	routerFrontedUrl: null,
	routedAppOrigin: null,
});

describe('acquireWallet — duplicate-address guard', () => {
	it('fails boot with an actionable bind-account error when two accounts share an address', async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), 'devstack-wallet-dup-'));
		const collidingAddress = `0x${'a'.repeat(64)}`;
		try {
			const ctx = makeCtx(stateRoot, [
				makeAccount('alice', collidingAddress),
				makeAccount('bob', collidingAddress),
			]);

			const exit = await Effect.runPromiseExit(
				Effect.scoped(acquireWallet({ accounts: WALLET_ACCOUNTS_ALL }, ctx)).pipe(
					Effect.provide(NodeFileSystem.layer),
				),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.findErrorOption(exit);
			expect(Option.isSome(err)).toBe(true);
			if (Option.isSome(err)) {
				expect(err.value._tag).toBe('WalletBootError');
				expect(err.value.phase).toBe('bind-account');
				// The actionable error names the colliding address so the
				// operator can find the offending pair.
				expect(err.value.message).toContain(collidingAddress);
				expect(err.value.hint).toBeDefined();
			}
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it('boots cleanly when each account owns a distinct address', async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), 'devstack-wallet-distinct-'));
		try {
			const ctx = makeCtx(stateRoot, [
				makeAccount('alice', `0x${'a'.repeat(64)}`),
				makeAccount('bob', `0x${'b'.repeat(64)}`),
			]);

			const value = await Effect.runPromise(
				Effect.scoped(acquireWallet({ accounts: WALLET_ACCOUNTS_ALL }, ctx)).pipe(
					Effect.provide(NodeFileSystem.layer),
				),
			);

			// The wallet resolved a value (the address-keyed sign map was
			// built without collision). Loopback fallback URL since no
			// router-fronted origin was supplied.
			expect(value.url).toBe('http://127.0.0.1:0');
			expect(value.localPort).toBe(0);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
