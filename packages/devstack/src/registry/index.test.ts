import { describe, expect, it } from 'vitest';

import { coinTokens } from '../coin.js';
import type { Account, Package, Service, Token } from '../core/types.js';
import { RegistryImpl } from './index.js';

const token = (name: string, overrides: Partial<Token> = {}): Token => ({
	name,
	type: `0x2::coin::Coin<0x2::sui::SUI>`,
	decimals: 9,
	...overrides,
});

const pkg = (name: string, overrides: Partial<Package> = {}): Package => ({
	name,
	packageId: '0xabc',
	captured: {},
	network: 'localnet',
	...overrides,
});

const account = (name: string, overrides: Partial<Account> = {}): Account => ({
	name,
	address: '0xdef',
	...overrides,
});

const service = (name: string, overrides: Partial<Service> = {}): Service => ({
	name,
	kind: 'rpc',
	url: 'http://localhost:9000',
	port: 9000,
	...overrides,
});

describe('RegistryImpl — core kinds', () => {
	it('packages supports register/list/find/require', () => {
		const reg = new RegistryImpl();
		const p = pkg('p1');
		reg.packages.register(p);
		expect(reg.packages.list()).toEqual([p]);
		expect(reg.packages.find('p1')).toBe(p);
		expect(reg.packages.require('p1')).toBe(p);
	});

	it('accounts supports register/list/find/require', () => {
		const reg = new RegistryImpl();
		const a = account('alice');
		reg.accounts.register(a);
		expect(reg.accounts.list()).toEqual([a]);
		expect(reg.accounts.find('alice')).toBe(a);
		expect(reg.accounts.require('alice')).toBe(a);
	});

	it('services supports register/list/find/require', () => {
		const reg = new RegistryImpl();
		const s = service('rpc');
		reg.services.register(s);
		expect(reg.services.list()).toEqual([s]);
		expect(reg.services.find('rpc')).toBe(s);
		expect(reg.services.require('rpc')).toBe(s);
	});

	it('find returns undefined and require throws on missing entries', () => {
		const reg = new RegistryImpl();
		expect(() => reg.packages.require('ghost')).toThrow(/packages has no entry named 'ghost'/);
		expect(() => reg.accounts.require('ghost')).toThrow(/accounts has no entry named 'ghost'/);
		expect(() => reg.services.require('ghost')).toThrow(/services has no entry named 'ghost'/);
	});

	it('register overwrites by name (idempotent — second register replaces the first)', () => {
		const reg = new RegistryImpl();
		const first = pkg('p1', { packageId: '0xaaa' });
		const second = pkg('p1', { packageId: '0xbbb' });
		reg.packages.register(first);
		reg.packages.register(second);
		expect(reg.packages.list()).toEqual([second]);
		expect(reg.packages.require('p1')).toBe(second);
	});
});

describe('RegistryImpl — coin namespace (tokens were demoted from core)', () => {
	it('coinTokens(reg) supports register/list/find/require', () => {
		const reg = new RegistryImpl();
		const sui = token('sui');
		coinTokens(reg).register(sui);
		expect(coinTokens(reg).list()).toEqual([sui]);
		expect(coinTokens(reg).find('sui')).toBe(sui);
		expect(coinTokens(reg).require('sui')).toBe(sui);
	});

	it('the dirty key is `coin/tokens`, not `tokens`', () => {
		const reg = new RegistryImpl();
		coinTokens(reg).register(token('sui'));
		expect(reg.isDirty('coin/tokens')).toBe(true);
		expect(reg.isDirty('tokens')).toBe(false);
	});
});

describe('RegistryImpl — namespaced kinds', () => {
	it('getOrCreateKind(ns, kind) auto-creates the query on first access', () => {
		const reg = new RegistryImpl();
		const walrusNodes = reg.getOrCreateKind<{ name: string }>('walrus', 'nodes');
		const node = { name: 'a' };
		walrusNodes.register(node);
		expect(walrusNodes.list()).toEqual([node]);
		expect(walrusNodes.find('a')).toBe(node);
	});

	it('getOrCreateKind returns the same query across calls', () => {
		const reg = new RegistryImpl();
		const a = reg.getOrCreateKind<{ name: string }>('walrus', 'nodes');
		a.register({ name: 'one' });
		const b = reg.getOrCreateKind<{ name: string }>('walrus', 'nodes');
		// Same query object (or, at minimum, a query backed by the same
		// underlying map) — registrations from `a` are visible through `b`.
		expect(b.list()).toEqual([{ name: 'one' }]);
	});

	it('namespaced kind dirty keys are formatted as <ns>/<kind>', () => {
		const reg = new RegistryImpl();
		const walrusNodes = reg.getOrCreateKind<{ name: string }>('walrus', 'nodes');
		walrusNodes.register({ name: 'a' });
		expect(reg.isDirty('walrus/nodes')).toBe(true);
		expect(reg.isDirty('nodes')).toBe(false);
	});
});

describe('RegistryImpl — dirty tracking', () => {
	it('isDirty is true after register and false after flushDirty', () => {
		const reg = new RegistryImpl();
		expect(reg.isDirty('packages')).toBe(false);
		reg.packages.register(pkg('p1'));
		expect(reg.isDirty('packages')).toBe(true);
		reg.flushDirty();
		expect(reg.isDirty('packages')).toBe(false);
	});

	it('flushDirty returns the prior dirty set AND clears it', () => {
		const reg = new RegistryImpl();
		reg.packages.register(pkg('p1'));
		reg.accounts.register(account('alice'));
		const flushed = reg.flushDirty();
		expect(flushed).toEqual(new Set(['packages', 'accounts']));
		expect(reg.isDirty('packages')).toBe(false);
		expect(reg.isDirty('accounts')).toBe(false);
		// Subsequent flush returns empty.
		expect(reg.flushDirty()).toEqual(new Set());
	});

	it('consumeDirty removes specific kinds without affecting others', () => {
		const reg = new RegistryImpl();
		reg.packages.register(pkg('p1'));
		reg.accounts.register(account('alice'));
		reg.services.register(service('rpc'));
		reg.consumeDirty(['packages', 'accounts']);
		expect(reg.isDirty('packages')).toBe(false);
		expect(reg.isDirty('accounts')).toBe(false);
		expect(reg.isDirty('services')).toBe(true);
	});

	it('consumeDirty on a never-dirtied kind is a no-op', () => {
		const reg = new RegistryImpl();
		reg.packages.register(pkg('p1'));
		reg.consumeDirty(['services', 'walrus/nodes']);
		expect(reg.isDirty('packages')).toBe(true);
	});

	it('namespaced register dirties the namespaced key only', () => {
		const reg = new RegistryImpl();
		const walrusNodes = reg.getOrCreateKind<{ name: string }>('walrus', 'nodes');
		walrusNodes.register({ name: 'a' });
		const flushed = reg.flushDirty();
		expect(flushed).toEqual(new Set(['walrus/nodes']));
	});

	it('unregister removes the entry and dirties the kind', () => {
		const reg = new RegistryImpl();
		reg.packages.register(pkg('p1'));
		reg.flushDirty();
		const removed = reg.packages.unregister('p1');
		expect(removed).toBe(true);
		expect(reg.packages.find('p1')).toBeUndefined();
		expect(reg.isDirty('packages')).toBe(true);
	});

	it('unregister returns false and does not dirty for a missing entry', () => {
		const reg = new RegistryImpl();
		const removed = reg.packages.unregister('does-not-exist');
		expect(removed).toBe(false);
		expect(reg.isDirty('packages')).toBe(false);
	});

	it('snapshot serializes core kinds + namespaces without touching dirty', () => {
		const reg = new RegistryImpl();
		coinTokens(reg).register(token('sui'));
		reg.packages.register(pkg('mock_usdc'));
		const walrusNodes = reg.getOrCreateKind<{ name: string; ip: string }>('walrus', 'nodes');
		walrusNodes.register({ name: 'a', ip: '10.0.0.10' });
		const dirtyBefore = new Set(reg.flushDirty()); // capture + clear
		const snap = reg.snapshot();
		expect(snap.packages.map((p) => p.name)).toEqual(['mock_usdc']);
		const coinNs = snap['coin'] as Record<string, Array<{ name: string }>>;
		expect(coinNs.tokens?.map((t) => t.name)).toEqual(['sui']);
		const ns = snap['walrus'] as Record<string, Array<{ name: string }>>;
		expect(ns.nodes?.map((n) => n.name)).toEqual(['a']);
		// snapshot is pure read — should not have re-dirtied anything we
		// just flushed.
		expect(reg.flushDirty().size).toBe(0);
		// And the prior dirty set was as we expected. `tokens` no longer a
		// core kind, so its registration appears as `coin/tokens`.
		expect(dirtyBefore).toEqual(new Set(['coin/tokens', 'packages', 'walrus/nodes']));
	});
});
