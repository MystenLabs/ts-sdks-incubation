import { describe, expect, it } from 'vitest';

import type { Account, Package, RegistryQuery, Service, Token } from '../core/types.js';
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
	it('tokens supports register/list/find/require', () => {
		const reg = new RegistryImpl();
		const sui = token('sui');
		reg.tokens.register(sui);
		expect(reg.tokens.list()).toEqual([sui]);
		expect(reg.tokens.find('sui')).toBe(sui);
		expect(reg.tokens.require('sui')).toBe(sui);
	});

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
		expect(reg.tokens.find('ghost')).toBeUndefined();
		expect(() => reg.tokens.require('ghost')).toThrow(/tokens has no entry named 'ghost'/);
		expect(() => reg.packages.require('ghost')).toThrow(/packages has no entry named 'ghost'/);
		expect(() => reg.accounts.require('ghost')).toThrow(/accounts has no entry named 'ghost'/);
		expect(() => reg.services.require('ghost')).toThrow(/services has no entry named 'ghost'/);
	});

	it('register overwrites by name (idempotent — second register replaces the first)', () => {
		const reg = new RegistryImpl();
		const first = token('sui', { decimals: 9 });
		const second = token('sui', { decimals: 6 });
		reg.tokens.register(first);
		reg.tokens.register(second);
		expect(reg.tokens.list()).toEqual([second]);
		expect(reg.tokens.require('sui')).toBe(second);
	});
});

describe('RegistryImpl — namespaced kinds', () => {
	it('ns<T>(name) auto-creates the kind on first access (Proxy auto-viv)', () => {
		const reg = new RegistryImpl();
		const walrus = reg.ns<{ nodes: RegistryQuery<{ name: string }> }>('walrus');
		const node = { name: 'a' };
		walrus.nodes.register(node);
		expect(walrus.nodes.list()).toEqual([node]);
		expect(walrus.nodes.find('a')).toBe(node);
	});

	it('ns returns the same namespace bag across calls (get-or-create)', () => {
		const reg = new RegistryImpl();
		const a = reg.ns<{ nodes: RegistryQuery<{ name: string }> }>('walrus');
		a.nodes.register({ name: 'one' });
		const b = reg.ns<{ nodes: RegistryQuery<{ name: string }> }>('walrus');
		// Different Proxies but the underlying map is shared, so registrations
		// from `a` are visible through `b`.
		expect(b.nodes.list()).toEqual([{ name: 'one' }]);
	});

	it('namespaced kind dirty keys are formatted as <ns>/<kind>', () => {
		const reg = new RegistryImpl();
		const walrus = reg.ns<{ nodes: RegistryQuery<{ name: string }> }>('walrus');
		walrus.nodes.register({ name: 'a' });
		expect(reg.isDirty('walrus/nodes')).toBe(true);
		expect(reg.isDirty('nodes')).toBe(false);
	});
});

describe('RegistryImpl — dirty tracking', () => {
	it('isDirty is true after register and false after flushDirty', () => {
		const reg = new RegistryImpl();
		expect(reg.isDirty('tokens')).toBe(false);
		reg.tokens.register(token('sui'));
		expect(reg.isDirty('tokens')).toBe(true);
		reg.flushDirty();
		expect(reg.isDirty('tokens')).toBe(false);
	});

	it('flushDirty returns the prior dirty set AND clears it', () => {
		const reg = new RegistryImpl();
		reg.tokens.register(token('sui'));
		reg.packages.register(pkg('p1'));
		const flushed = reg.flushDirty();
		expect(flushed).toEqual(new Set(['tokens', 'packages']));
		expect(reg.isDirty('tokens')).toBe(false);
		expect(reg.isDirty('packages')).toBe(false);
		// Subsequent flush returns empty.
		expect(reg.flushDirty()).toEqual(new Set());
	});

	it('consumeDirty removes specific kinds without affecting others', () => {
		const reg = new RegistryImpl();
		reg.tokens.register(token('sui'));
		reg.packages.register(pkg('p1'));
		reg.accounts.register(account('alice'));
		reg.consumeDirty(['tokens', 'accounts']);
		expect(reg.isDirty('tokens')).toBe(false);
		expect(reg.isDirty('accounts')).toBe(false);
		expect(reg.isDirty('packages')).toBe(true);
	});

	it('consumeDirty on a never-dirtied kind is a no-op', () => {
		const reg = new RegistryImpl();
		reg.tokens.register(token('sui'));
		reg.consumeDirty(['services', 'walrus/nodes']);
		expect(reg.isDirty('tokens')).toBe(true);
	});

	it('namespaced register dirties the namespaced key only', () => {
		const reg = new RegistryImpl();
		const walrus = reg.ns<{ nodes: RegistryQuery<{ name: string }> }>('walrus');
		walrus.nodes.register({ name: 'a' });
		const flushed = reg.flushDirty();
		expect(flushed).toEqual(new Set(['walrus/nodes']));
	});

	it('unregister removes the entry and dirties the kind', () => {
		const reg = new RegistryImpl();
		reg.tokens.register(token('sui'));
		reg.flushDirty();
		const removed = reg.tokens.unregister('sui');
		expect(removed).toBe(true);
		expect(reg.tokens.find('sui')).toBeUndefined();
		expect(reg.isDirty('tokens')).toBe(true);
	});

	it('unregister returns false and does not dirty for a missing entry', () => {
		const reg = new RegistryImpl();
		const removed = reg.tokens.unregister('does-not-exist');
		expect(removed).toBe(false);
		expect(reg.isDirty('tokens')).toBe(false);
	});

	it('snapshot serializes core kinds + namespaces without touching dirty', () => {
		const reg = new RegistryImpl();
		reg.tokens.register(token('sui'));
		reg.packages.register(pkg('mock_usdc'));
		const walrus = reg.ns<{ nodes: RegistryQuery<{ name: string; ip: string }> }>('walrus');
		walrus.nodes.register({ name: 'a', ip: '10.0.0.10' });
		const dirtyBefore = new Set(reg.flushDirty()); // capture + clear
		const snap = reg.snapshot();
		expect((snap.tokens as Array<{ name: string }>).map((t) => t.name)).toEqual(['sui']);
		expect((snap.packages as Array<{ name: string }>).map((p) => p.name)).toEqual(['mock_usdc']);
		const ns = snap['walrus'] as Record<string, Array<{ name: string }>>;
		expect(ns.nodes?.map((n) => n.name)).toEqual(['a']);
		// snapshot is pure read — should not have re-dirtied anything we
		// just flushed.
		expect(reg.flushDirty().size).toBe(0);
		// And the prior dirty set was as we expected.
		expect(dirtyBefore).toEqual(new Set(['tokens', 'packages', 'walrus/nodes']));
	});
});
