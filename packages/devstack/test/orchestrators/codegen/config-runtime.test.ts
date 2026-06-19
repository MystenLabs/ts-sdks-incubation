// Config-runtime resolver source tests.
//
// `CONFIG_RUNTIME_SOURCE` is emitted verbatim into each app's committed
// `src/generated/config-runtime.ts`. It is a constant string (NOT routed
// through the literal renderer), so these tests transpile it with the
// TypeScript compiler and evaluate it in a `vm` sandbox against a controlled
// `__DEVSTACK_DEPLOYMENT__` ENVELOPE global — exercising the REAL emitted
// resolver behavior, not a re-implementation.

import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';

import { CONFIG_RUNTIME_SOURCE } from '../../../src/orchestrators/codegen/config-runtime.ts';

interface Resolver {
	resolveAccounts: () => Record<string, string>;
	DevstackConfigMissingError: new (detail: string) => Error;
	// Deployment API (the typed, multi-network surface).
	loadDeployment: () => LoadedDeploymentLike;
	loadDeploymentOptional: () => LoadedDeploymentLike | null;
	requireId: (deployment: NetworkDeploymentLike, mvrPlaceholder: string) => string;
	requireValue: <T = unknown>(
		deployment: NetworkDeploymentLike,
		namespace: string,
		key: string,
	) => T;
	optionalValue: <T = unknown>(
		deployment: NetworkDeploymentLike,
		namespace: string,
		key: string,
	) => T | undefined;
}

interface NetworkDeploymentLike {
	readonly network: string;
	readonly rpc: string;
	readonly packages: Record<string, { id: string }>;
	readonly mvrOverrides: { packages: Record<string, string>; types: Record<string, string> };
	readonly values?: Record<string, Record<string, unknown>>;
}
interface LoadedDeploymentLike {
	readonly defaultNetwork: string;
	readonly networkNames: readonly string[];
	readonly forNetwork: (network: string) => NetworkDeploymentLike;
}

/** Transpile the emitted source to CJS and evaluate it with the given
 *  `__DEVSTACK_DEPLOYMENT__` envelope global, returning the module exports. */
const loadResolver = (injected: unknown): Resolver => {
	const js = ts.transpileModule(CONFIG_RUNTIME_SOURCE, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const exports: Record<string, unknown> = {};
	const sandbox = {
		exports,
		module: { exports },
		__DEVSTACK_DEPLOYMENT__: injected,
	};
	createContext(sandbox);
	runInContext(js, sandbox);
	return sandbox.module.exports as unknown as Resolver;
};

/** Build a single-network envelope around one `NetworkDeployment` unit. Dev
 *  `accounts` ride the ENVELOPE (network-agnostic), NOT the per-network unit. */
const envelope = (
	unit: {
		network: string;
		rpc: string;
		packages?: Record<string, { id: string }>;
		mvrOverrides?: { packages: Record<string, string>; types: Record<string, string> };
		values?: Record<string, Record<string, unknown>>;
		local?: boolean;
	},
	accounts?: Record<string, string>,
) => ({
	defaultNetwork: unit.network,
	networks: {
		[unit.network]: {
			packages: {},
			mvrOverrides: { packages: {}, types: {} },
			...unit,
		},
	},
	...(accounts !== undefined ? { accounts } : {}),
});

const localUnit = {
	network: 'localnet',
	rpc: 'http://127.0.0.1:9000',
	local: true,
	packages: {},
	mvrOverrides: { packages: { '@local/demo': '0xabc' }, types: {} },
	values: { 'coin:managed_coin': { treasuryCapId: '0xcap' } },
};
const idsBlob = envelope(localUnit, { alice: '0xa11ce' });

/** A two-network envelope (localnet default + a committed testnet). */
const multiBlob = {
	defaultNetwork: 'localnet',
	networks: {
		localnet: {
			network: 'localnet',
			rpc: 'http://127.0.0.1:9000',
			local: true,
			packages: {},
			mvrOverrides: { packages: { '@local/demo': '0xabc' }, types: {} },
			values: { 'coin:managed_coin': { treasuryCapId: '0xcap' } },
		},
		testnet: {
			network: 'testnet',
			rpc: 'http://testnet.example',
			local: false,
			packages: {},
			mvrOverrides: { packages: { '@local/demo': '0xdef' }, types: {} },
			values: {},
		},
	},
	accounts: { alice: '0xa11ce' },
};

const UNRESOLVED = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('CONFIG_RUNTIME_SOURCE shape', () => {
	it('exports the deployment API surface', () => {
		for (const name of [
			'loadDeployment',
			'loadDeploymentOptional',
			'requireId',
			'requireValue',
			'optionalValue',
			'resolveAccounts',
		]) {
			expect(CONFIG_RUNTIME_SOURCE).toContain(`export const ${name}`);
		}
	});

	it('no longer exports the legacy resolve*() shims', () => {
		for (const name of [
			'resolveId',
			'resolveNetwork',
			'resolveNetworks',
			'resolveActiveNetwork',
			'resolveValue',
			'resolveValueOptional',
		]) {
			expect(CONFIG_RUNTIME_SOURCE).not.toContain(`export const ${name}`);
		}
	});

	it('exports the envelope-level resolveAccounts helper', () => {
		expect(CONFIG_RUNTIME_SOURCE).toContain('export const resolveAccounts');
		// Accounts hoisted OUT of the per-network unit — the per-network
		// `NetworkDeployment` interface carries no `accounts` field.
		expect(CONFIG_RUNTIME_SOURCE).not.toContain('readonly accounts: {');
	});
});

describe('resolveAccounts (envelope-level dev accounts)', () => {
	it('returns the envelope accounts map', () => {
		const r = loadResolver(idsBlob);
		expect(r.resolveAccounts()).toEqual({ alice: '0xa11ce' });
	});

	it('returns the envelope accounts from a multi-network envelope', () => {
		const r = loadResolver(multiBlob);
		expect(r.resolveAccounts()).toEqual({ alice: '0xa11ce' });
	});

	it('returns {} (no throw) when no deployment was injected', () => {
		const r = loadResolver(null);
		expect(r.resolveAccounts()).toEqual({});
	});

	it('returns {} when the envelope carries no accounts (prod build)', () => {
		const r = loadResolver(envelope(localUnit));
		expect(r.resolveAccounts()).toEqual({});
	});
});

describe('deployment API', () => {
	it('loadDeployment reads the one-network envelope directly', () => {
		const r = loadResolver(idsBlob);
		const dep = r.loadDeployment();
		expect(dep.defaultNetwork).toBe('localnet');
		expect(dep.networkNames).toEqual(['localnet']);
		const net = dep.forNetwork('localnet');
		expect(net.rpc).toBe('http://127.0.0.1:9000');
		expect(net.mvrOverrides.packages['@local/demo']).toBe('0xabc');
	});

	it('loadDeployment honors a multi-network envelope (forNetwork + defaultNetwork)', () => {
		const r = loadResolver(multiBlob);
		const dep = r.loadDeployment();
		expect(dep.defaultNetwork).toBe('localnet');
		expect([...dep.networkNames].sort()).toEqual(['localnet', 'testnet']);
		// `forNetwork('testnet')` returns the testnet entry (NOT the default).
		const testnet = dep.forNetwork('testnet');
		expect(testnet.rpc).toBe('http://testnet.example');
		expect(r.requireId(testnet, '@local/demo')).toBe('0xdef');
		// The default network is still distinct.
		expect(dep.forNetwork('localnet').rpc).toBe('http://127.0.0.1:9000');
	});

	it('loadDeployment throws when no deployment was injected', () => {
		const r = loadResolver(null);
		expect(() => r.loadDeployment()).toThrow(r.DevstackConfigMissingError);
	});

	it('loadDeploymentOptional returns null when no deployment was injected', () => {
		const r = loadResolver(null);
		expect(r.loadDeploymentOptional()).toBeNull();
	});

	it('forNetwork throws for a network with no deployment', () => {
		const r = loadResolver(idsBlob);
		expect(() => r.loadDeployment().forNetwork('mainnet')).toThrow(r.DevstackConfigMissingError);
	});

	it('requireId resolves an mvr placeholder and throws on missing', () => {
		const r = loadResolver(idsBlob);
		const net = r.loadDeployment().forNetwork('localnet');
		expect(r.requireId(net, '@local/demo')).toBe('0xabc');
		expect(() => r.requireId(net, '@local/missing')).toThrow(r.DevstackConfigMissingError);
	});

	it('requireId throws on the all-zero sentinel', () => {
		const r = loadResolver(
			envelope({
				...localUnit,
				mvrOverrides: { packages: { '@local/demo': UNRESOLVED }, types: {} },
			}),
		);
		const net = r.loadDeployment().forNetwork('localnet');
		expect(() => r.requireId(net, '@local/demo')).toThrow(r.DevstackConfigMissingError);
	});

	it('requireValue / optionalValue read the values channel off a deployment', () => {
		const r = loadResolver(idsBlob);
		const net = r.loadDeployment().forNetwork('localnet');
		expect(r.requireValue(net, 'coin:managed_coin', 'treasuryCapId')).toBe('0xcap');
		expect(r.optionalValue(net, 'coin:managed_coin', 'treasuryCapId')).toBe('0xcap');
		expect(r.optionalValue(net, 'coin:managed_coin', 'metadataId')).toBeUndefined();
		expect(() => r.requireValue(net, 'coin:managed_coin', 'metadataId')).toThrow(
			r.DevstackConfigMissingError,
		);
	});
});
