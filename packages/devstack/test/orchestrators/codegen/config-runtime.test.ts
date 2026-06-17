// Config-runtime resolver source tests.
//
// `CONFIG_RUNTIME_SOURCE` is emitted verbatim into each app's committed
// `src/generated/config-runtime.ts`. It is a constant string (NOT routed
// through the literal renderer), so these tests transpile it with the
// TypeScript compiler and evaluate it in a `vm` sandbox against a controlled
// `__DEVSTACK_IDS__` global — exercising the REAL emitted resolver behavior,
// not a re-implementation.

import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';

import { CONFIG_RUNTIME_SOURCE } from '../../../src/orchestrators/codegen/config-runtime.ts';

interface Resolver {
	resolveId: (mvrPlaceholder: string) => string;
	resolveNetwork: () => string;
	resolveNetworks: () => Record<string, { rpc: string }>;
	resolveActiveNetwork: () => { rpc: string };
	resolveValue: <T = unknown>(namespace: string, key: string) => T;
	resolveValueOptional: <T = unknown>(namespace: string, key: string) => T | undefined;
	DevstackConfigMissingError: new (detail: string) => Error;
}

/** Transpile the emitted source to CJS and evaluate it with the given
 *  `__DEVSTACK_IDS__` global, returning the module exports. */
const loadResolver = (injectedIds: unknown): Resolver => {
	const js = ts.transpileModule(CONFIG_RUNTIME_SOURCE, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const exports: Record<string, unknown> = {};
	const sandbox = {
		exports,
		module: { exports },
		__DEVSTACK_IDS__: injectedIds,
	};
	createContext(sandbox);
	runInContext(js, sandbox);
	return sandbox.module.exports as unknown as Resolver;
};

const idsBlob = {
	network: 'localnet',
	networks: { localnet: { rpc: 'http://127.0.0.1:9000' } },
	packages: {},
	accounts: {},
	mvrOverrides: { '@local/demo': '0xabc' },
	values: { 'coin:managed_coin': { treasuryCapId: '0xcap' } },
};

const UNRESOLVED =
	'0x0000000000000000000000000000000000000000000000000000000000000000';

describe('CONFIG_RUNTIME_SOURCE shape', () => {
	it('exports the two additive DX helpers', () => {
		expect(CONFIG_RUNTIME_SOURCE).toContain('export const resolveActiveNetwork');
		expect(CONFIG_RUNTIME_SOURCE).toContain('export const resolveValueOptional');
		// The original resolvers stay intact (additive sugar, not a rename).
		for (const name of ['resolveId', 'resolveNetwork', 'resolveNetworks', 'resolveValue']) {
			expect(CONFIG_RUNTIME_SOURCE).toContain(`export const ${name}`);
		}
	});
});

describe('resolveActiveNetwork', () => {
	it('returns the active network entry', () => {
		const r = loadResolver(idsBlob);
		expect(r.resolveActiveNetwork()).toEqual({ rpc: 'http://127.0.0.1:9000' });
	});

	it('throws DevstackConfigMissingError when the active network has no entry', () => {
		const r = loadResolver({ ...idsBlob, network: 'testnet' });
		expect(() => r.resolveActiveNetwork()).toThrow(r.DevstackConfigMissingError);
	});

	it('throws when no ids were injected', () => {
		const r = loadResolver(null);
		expect(() => r.resolveActiveNetwork()).toThrow(r.DevstackConfigMissingError);
	});
});

describe('resolveValueOptional', () => {
	it('returns the resolved value when present (parity with resolveValue)', () => {
		const r = loadResolver(idsBlob);
		expect(r.resolveValueOptional('coin:managed_coin', 'treasuryCapId')).toBe('0xcap');
		expect(r.resolveValue('coin:managed_coin', 'treasuryCapId')).toBe('0xcap');
	});

	it('returns undefined (NOT throws) when the value is absent', () => {
		const r = loadResolver(idsBlob);
		expect(r.resolveValueOptional('coin:managed_coin', 'metadataId')).toBeUndefined();
		// The throwing variant stays loud for the same lookup.
		expect(() => r.resolveValue('coin:managed_coin', 'metadataId')).toThrow(
			r.DevstackConfigMissingError,
		);
	});

	it('returns undefined for the all-zero sentinel', () => {
		const r = loadResolver({
			...idsBlob,
			values: { 'coin:managed_coin': { treasuryCapId: UNRESOLVED } },
		});
		expect(r.resolveValueOptional('coin:managed_coin', 'treasuryCapId')).toBeUndefined();
	});

	it('returns undefined when no ids were injected (no throw)', () => {
		const r = loadResolver(null);
		expect(r.resolveValueOptional('coin:managed_coin', 'treasuryCapId')).toBeUndefined();
	});
});
