import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import type { LocalnetActionRunContext } from '../core/types.js';
import { RegistryImpl } from '../registry/index.js';
import { createTestActionContext } from './test-context.js';

describe('createTestActionContext', () => {
	it('returns a localnet context with sensible defaults', () => {
		const ctx = createTestActionContext();
		expect(ctx.network).toBe('localnet');
		expect(ctx.appName).toBe('test-app');
		expect(ctx.inputHash).toBe('test-input-hash');
		// Localnet branch carries `stack` and `ports`.
		if (ctx.network !== 'localnet') throw new Error('expected localnet branch');
		expect(ctx.stack).toBe('main');
		expect(ctx.ports).toBeDefined();
		// Empty accounts + fresh registry.
		expect(ctx.accounts.names()).toEqual([]);
		expect(ctx.registry.packages.list()).toEqual([]);
		expect(ctx.registry.accounts.list()).toEqual([]);
		expect(ctx.registry.services.list()).toEqual([]);
	});

	it('threads pre-seeded accounts through ctx.accounts.get/has/names', () => {
		const alice = new Ed25519Keypair() as unknown as Signer;
		const bob = new Ed25519Keypair() as unknown as Signer;
		const ctx = createTestActionContext({ accounts: { alice, bob } });
		expect(ctx.accounts.has('alice')).toBe(true);
		expect(ctx.accounts.has('bob')).toBe(true);
		expect(ctx.accounts.has('charlie')).toBe(false);
		expect(ctx.accounts.get('alice')).toBe(alice);
		expect(ctx.accounts.get('bob')).toBe(bob);
		// Sorted-or-not isn't contractual, but the names should be exactly the seeded set.
		expect(ctx.accounts.names().sort()).toEqual(['alice', 'bob']);
	});

	it('throws a labelled error for unseeded account lookups', () => {
		const ctx = createTestActionContext({
			accounts: { alice: new Ed25519Keypair() as unknown as Signer },
		});
		expect(() => ctx.accounts.get('charlie')).toThrow(/charlie.*not seeded.*alice/);
	});

	it("captures appendLog lines into the user's sink", () => {
		const sink: string[] = [];
		const ctx = createTestActionContext({ appendLogSink: sink });
		ctx.appendLog('hello');
		ctx.appendLog('world');
		expect(sink).toEqual(['hello', 'world']);
	});

	it('allocates the preferred port when no slot override is set', async () => {
		const ctx = createTestActionContext();
		if (ctx.network !== 'localnet') throw new Error('expected localnet branch');
		const ports = await ctx.ports.allocate({ slot: 'redis.default', preferred: 9000 });
		expect(ports).toEqual([9000]);
	});

	it('returns the override port when a slot override is set', async () => {
		const ctx = createTestActionContext({ ports: { 'redis.default': 7777 } });
		if (ctx.network !== 'localnet') throw new Error('expected localnet branch');
		// Override wins over `preferred`.
		const ports = await ctx.ports.allocate({ slot: 'redis.default', preferred: 9000 });
		expect(ports).toEqual([7777]);
	});

	it('returns a contiguous range when count > 1', async () => {
		const ctx = createTestActionContext();
		if (ctx.network !== 'localnet') throw new Error('expected localnet branch');
		const ports = await ctx.ports.allocate({ slot: 'walrus.nodes', preferred: 11000, count: 4 });
		expect(ports).toEqual([11000, 11001, 11002, 11003]);
	});

	it('honours a pre-built registry across two synthesized contexts', () => {
		const registry = new RegistryImpl();
		const ctxA = createTestActionContext({ registry });
		const ctxB = createTestActionContext({ registry });
		ctxA.registry.services.register({
			name: 'redis',
			kind: 'cache',
			url: 'redis://localhost:6379',
			port: 6379,
		});
		// ctxB sees the registration ctxA performed.
		expect(ctxB.registry.services.find('redis')?.port).toBe(6379);
	});

	it('plugin-style usage: a plugin author can register a service via provides.registry', async () => {
		// Mirrors the docstring example: a plugin's registry-rehydrate hook
		// fires against a synthesized ctx and the service shows up in
		// `ctx.registry.services`.
		const registerHook = async (ctx: LocalnetActionRunContext) => {
			ctx.registry.services.register({
				name: 'redis',
				kind: 'cache',
				url: `redis://localhost:${6379}`,
				port: 6379,
			});
		};
		const ctx = createTestActionContext();
		if (ctx.network !== 'localnet') throw new Error('expected localnet branch');
		await registerHook(ctx);
		expect(ctx.registry.services.find('redis')).toBeDefined();
	});

	it('builds a live-net (testnet) context that omits stack and ports', () => {
		const ctx = createTestActionContext({ network: 'testnet' });
		expect(ctx.network).toBe('testnet');
		// Discriminated-union narrowing: live-net branch has no `stack`/`ports`.
		if (ctx.network === 'localnet') {
			throw new Error('expected live-net branch');
		}
		expect('stack' in ctx).toBe(false);
		expect('ports' in ctx).toBe(false);
	});

	it('builds a live-net (mainnet) context analogously', () => {
		const ctx = createTestActionContext({ network: 'mainnet' });
		expect(ctx.network).toBe('mainnet');
		if (ctx.network === 'localnet') {
			throw new Error('expected live-net branch');
		}
		expect('stack' in ctx).toBe(false);
		expect('ports' in ctx).toBe(false);
	});

	it('passes through user-supplied appName / appDir / stack / inputHash', () => {
		const ctx = createTestActionContext({
			appName: 'arena',
			appDir: '/var/tmp/arena-test',
			stack: 'integration',
			inputHash: 'abc123',
		});
		expect(ctx.appName).toBe('arena');
		expect(ctx.appDir).toBe('/var/tmp/arena-test');
		expect(ctx.inputHash).toBe('abc123');
		if (ctx.network !== 'localnet') throw new Error('expected localnet branch');
		expect(ctx.stack).toBe('integration');
	});
});
