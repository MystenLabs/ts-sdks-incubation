import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountFactory, AccountSpec } from '../core/types.js';
import { resolveAccounts } from './accounts.js';

const fakeSigner = (label: string): Signer => {
	const kp = new Ed25519Keypair() as Ed25519Keypair & { __label: string };
	kp.__label = label;
	return kp;
};

let tmpDirs: string[] = [];

const newAppDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-accounts-'));
	tmpDirs.push(dir);
	return dir;
};

beforeEach(() => {
	tmpDirs = [];
});

afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('resolveAccounts — empty input', () => {
	it('returns a context with no names and a helpful error on get()', () => {
		const ctx = resolveAccounts({
			specs: {},
			appDir: '/tmp/none',
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		expect(ctx.names()).toEqual([]);
		expect(ctx.has('alice')).toBe(false);
		expect(() => ctx.get('alice')).toThrow(/no accounts declared/);
	});
});

describe('resolveAccounts — implicit generatedKeypair on localnet', () => {
	it('materializes a stable keypair for `{}` specs and writes to disk', () => {
		const appDir = newAppDir();
		const ctx = resolveAccounts({
			specs: { alice: {}, bob: {} },
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		const alice = ctx.get('alice');
		const bob = ctx.get('bob');
		expect(alice.toSuiAddress()).toMatch(/^0x[0-9a-f]+$/);
		expect(bob.toSuiAddress()).toMatch(/^0x[0-9a-f]+$/);
		expect(alice.toSuiAddress()).not.toBe(bob.toSuiAddress());
		// Persisted bech32 file at the path the dev wallet's
		// virtual:devstack-keys plugin reads.
		const keyFile = join(appDir, '.devstack', 'stacks', 'main', '.keys', 'alice.key');
		const stat = statSync(keyFile);
		expect(stat.isFile()).toBe(true);
		expect(readFileSync(keyFile, 'utf8').trim()).toMatch(/^suiprivkey1/);
	});

	it('reuses the on-disk key on a second resolve (stable across cycles)', () => {
		const appDir = newAppDir();
		const first = resolveAccounts({
			specs: { alice: {} },
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		const second = resolveAccounts({
			specs: { alice: {} },
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		expect(first.get('alice').toSuiAddress()).toBe(second.get('alice').toSuiAddress());
	});

	it('falls through to generatedKeypair when only live-net slots are set', () => {
		const appDir = newAppDir();
		const ctx = resolveAccounts({
			specs: { publisher: { testnet: fakeSigner('cli'), mainnet: fakeSigner('env') } },
			appDir,
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		// localnet path: no testnet/mainnet/default slot matches → implicit
		// generatedKeypair fires and writes publisher.key.
		const signer = ctx.get('publisher');
		expect(signer.toSuiAddress()).toMatch(/^0x[0-9a-f]+$/);
	});

	it('throws on non-localnet without an explicit factory and surfaces lazily on get()', () => {
		const ctx = resolveAccounts({
			specs: { alice: {} },
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		// Materialization captures the error per-account; resolveAccounts
		// itself doesn't throw so the rest of the action graph keeps running.
		expect(ctx.has('alice')).toBe(true);
		expect(() => ctx.get('alice')).toThrow(/no factory configured for network 'testnet'/);
	});
});

describe('resolveAccounts — explicit Signer slots', () => {
	it('uses the per-network slot when set', () => {
		const testnetSigner = fakeSigner('testnet');
		const mainnetSigner = fakeSigner('mainnet');
		const spec: AccountSpec = { testnet: testnetSigner, mainnet: mainnetSigner };

		const tn = resolveAccounts({
			specs: { publisher: spec },
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(tn.get('publisher')).toBe(testnetSigner);

		const mn = resolveAccounts({
			specs: { publisher: spec },
			appDir: newAppDir(),
			stack: 'main',
			network: 'mainnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(mn.get('publisher')).toBe(mainnetSigner);
	});

	it('falls back to `default` when the network slot is unset', () => {
		const fallback = fakeSigner('default');
		const ctx = resolveAccounts({
			specs: { publisher: { default: fallback } },
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(ctx.get('publisher')).toBe(fallback);
	});

	it('treats a bare Signer spec as default everywhere', () => {
		const everywhere = fakeSigner('all');
		const tn = resolveAccounts({
			specs: { publisher: everywhere },
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(tn.get('publisher')).toBe(everywhere);
		const mn = resolveAccounts({
			specs: { publisher: everywhere },
			appDir: newAppDir(),
			stack: 'main',
			network: 'mainnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(mn.get('publisher')).toBe(everywhere);
	});
});

describe('resolveAccounts — factory invocation', () => {
	it('invokes a factory with the full context (account name + appDir + stack + network + rpcUrl)', () => {
		const factory: AccountFactory = vi.fn((ctx) => {
			expect(ctx.accountName).toBe('publisher');
			expect(ctx.appDir).toBe('/tmp/app');
			expect(ctx.stack).toBe('scratch');
			expect(ctx.network).toBe('testnet');
			expect(ctx.rpcUrl).toBe('https://rpc.example');
			return fakeSigner('built');
		});
		const ctx = resolveAccounts({
			specs: { publisher: { testnet: factory } },
			appDir: '/tmp/app',
			stack: 'scratch',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		const signer = ctx.get('publisher');
		expect(factory).toHaveBeenCalledTimes(1);
		expect((signer as unknown as { __label: string }).__label).toBe('built');
	});

	it('captures factory errors per-account and re-throws them on get()', () => {
		const failing: AccountFactory = () => {
			throw new Error('keystore unreachable');
		};
		const fine = fakeSigner('fine');
		const ctx = resolveAccounts({
			specs: {
				publisher: { testnet: failing },
				deployer: { testnet: fine },
			},
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		// Independent accounts not poisoned by sibling failure.
		expect(ctx.get('deployer')).toBe(fine);
		expect(() => ctx.get('publisher')).toThrow(/keystore unreachable/);
	});

	it('captures async factories as an unsupported error (eager-only contract)', () => {
		const asyncFactory: AccountFactory = async () => fakeSigner('later');
		const ctx = resolveAccounts({
			specs: { publisher: { testnet: asyncFactory } },
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(() => ctx.get('publisher')).toThrow(/async factory unsupported/);
	});
});

describe('resolveAccounts — lookup behavior', () => {
	it('lists declared names from `names()` even when materialization failed', () => {
		const failing: AccountFactory = () => {
			throw new Error('boom');
		};
		const ctx = resolveAccounts({
			specs: { publisher: { testnet: failing }, alice: {} },
			appDir: newAppDir(),
			stack: 'main',
			network: 'testnet',
			rpcUrl: 'https://rpc.example',
		});
		expect(ctx.names().sort()).toEqual(['alice', 'publisher']);
		expect(ctx.has('publisher')).toBe(true);
		expect(ctx.has('ghost')).toBe(false);
	});

	it('throws on unknown name with a list of declared accounts', () => {
		const ctx = resolveAccounts({
			specs: { alice: {}, bob: {} },
			appDir: newAppDir(),
			stack: 'main',
			network: 'localnet',
			rpcUrl: '',
		});
		expect(() => ctx.get('carol')).toThrow(/unknown account.*alice.*bob/);
	});
});
