// Strict app-specific `deployment.ts` renderer tests.
//
// `renderDeploymentStrict` emits the app-specific `src/generated/deployment.ts`
// — the strict type a prod author's `deployments/<net>.ts` is checked
// against. These tests assert the rendered SHAPE (string-level) AND that a
// real `deployments/<net>.ts` `satisfies AppNetworkDeployment` actually
// type-checks (an in-memory `tsc` program over the rendered file + a sample
// committed deployment), so the completeness guarantee is exercised, not just
// asserted by string match.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { isValidNamedType } from '@mysten/sui/utils';

import {
	renderDeploymentStrict,
	type DeploymentStrictInput,
} from '../../../src/orchestrators/codegen/deployment-strict.ts';

// A minimal stand-in for the emitted `config-runtime.ts`'s `NetworkDeployment`
// type — enough for the strict `deployment.ts` to import + narrow. Mirrors the
// real interface's load-bearing fields. `mvrOverrides` is the nested @mysten
// override shape `{ packages, types }`.
const CONFIG_RUNTIME_STUB = `
export interface NetworkDeployment {
	readonly network?: string;
	readonly rpc: string;
	readonly chainId?: string;
	readonly faucet?: string | null;
	readonly graphql?: string | null;
	readonly local?: boolean;
	readonly packages: {
		readonly [name: string]: { readonly id: string; readonly objects?: { readonly [k: string]: string } };
	};
	readonly mvrOverrides: {
		readonly packages: { readonly [mvrPlaceholder: string]: string };
		readonly types: { readonly [namedType: string]: string };
	};
	readonly values?: { readonly [namespace: string]: { readonly [key: string]: unknown } };
}
`;

/** Type-check the rendered `deployment.ts` (rewritten to import the stub) plus
 *  a caller-supplied `deployments/<net>.ts` source, in-memory. Returns the
 *  semantic diagnostics (empty ⇒ compiles clean). */
const typeCheck = (deploymentTs: string, sampleTs: string): ReadonlyArray<string> => {
	// Rewrite the `./config-runtime.js` import to a local stub module the
	// in-memory program resolves; sample imports the rendered `deployment.ts`.
	const files: Record<string, string> = {
		'/config-runtime.ts': CONFIG_RUNTIME_STUB,
		'/deployment.ts': deploymentTs.replace("from './config-runtime.js'", "from './config-runtime'"),
		'/sample.ts': sampleTs,
	};
	const options: ts.CompilerOptions = {
		strict: true,
		noEmit: true,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2022,
		skipLibCheck: true,
	};
	const host = ts.createCompilerHost(options);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const virtual = files[fileName];
		if (virtual !== undefined) {
			return ts.createSourceFile(fileName, virtual, languageVersion, true);
		}
		return originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);
	};
	host.fileExists = (fileName) => files[fileName] !== undefined || ts.sys.fileExists(fileName);
	host.readFile = (fileName) => files[fileName] ?? ts.sys.readFile(fileName);
	const program = ts.createProgram(['/sample.ts'], options, host);
	return program
		.getSemanticDiagnostics()
		.filter((d) => d.file !== undefined && d.file.fileName.startsWith('/'))
		.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
};

// A counter-style app — one package, one named type, NO service values.
const counterInput: DeploymentStrictInput = {
	localNetworkName: 'localnet',
	packageNames: ['counter'],
	mvrPlaceholders: ['@local/counter'],
	mvrTypeTags: ['@local/counter::counter::Counter'],
	providedNetworks: [],
	serviceValues: {},
};

// A service-bearing app — package + named types + required service values
// (deepbook ids/pool, a coin's decimals + full type, a walrus endpoint).
const serviceInput: DeploymentStrictInput = {
	localNetworkName: 'localnet',
	packageNames: ['trader'],
	mvrPlaceholders: ['@local/trader'],
	mvrTypeTags: ['@local/trader::market::Order'],
	providedNetworks: ['testnet'],
	serviceValues: {
		'deepbook:DBTC_DUSDC': { poolId: 'string', registryId: 'string' },
		'coin:DBTC': { decimals: 'number', fullCoinType: 'string' },
		walrus: { aggregator: 'string', publisher: 'string | null' },
	},
};

// A counter-style app that declares NO MVR types — `types` must be OPT-IN
// (optional + loose), so a deployment need not write a `types` block.
const noTypesInput: DeploymentStrictInput = {
	localNetworkName: 'localnet',
	packageNames: ['counter'],
	mvrPlaceholders: ['@local/counter'],
	mvrTypeTags: [],
	providedNetworks: ['testnet'],
	serviceValues: {},
};

describe('renderDeploymentStrict — shape', () => {
	it('emits AppPackages exhaustive over declared package names', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain('export interface AppPackages {');
		expect(src).toContain('readonly "counter": { readonly id: string;');
	});

	it('mvrOverrides is the nested { packages, types } @mysten override shape', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain('readonly mvrOverrides: {');
		expect(src).toContain('readonly packages: {');
		expect(src).toContain('"@local/counter": string;');
		expect(src).toContain('readonly types: {');
		expect(src).toContain('"@local/counter::counter::Counter": string;');
	});

	it('every emitted mvrOverrides.types key passes isValidNamedType', () => {
		// Mirror mvr-named-form.test.ts's isValidNamedPackage usage: the @mysten
		// MVR `types` channel rejects keys that fail `isValidNamedType`, so the
		// emitted keys MUST pass it.
		for (const tag of serviceInput.mvrTypeTags) {
			expect(isValidNamedType(tag)).toBe(true);
		}
		const src = renderDeploymentStrict(serviceInput);
		expect(src).toContain('"@local/trader::market::Order": string;');
	});

	it('with NO declared types, mvrOverrides.types is OPTIONAL + loose', () => {
		const src = renderDeploymentStrict(noTypesInput);
		expect(src).toContain('readonly types?: { readonly [namedType: string]: string };');
	});

	it('AppNetworkDeployment omits accounts (hoisted to the envelope)', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain("Omit<NetworkDeployment, 'packages' | 'mvrOverrides' | 'values'>");
		expect(src).not.toContain('accounts:');
	});

	it('a service-less app keeps values OPTIONAL + loose', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain("readonly values?: NetworkDeployment['values'];");
	});

	it('a service app requires each value namespace/key with its TS type', () => {
		const src = renderDeploymentStrict(serviceInput);
		expect(src).toContain('readonly values: {');
		expect(src).toContain('"deepbook:DBTC_DUSDC": {');
		expect(src).toContain('"poolId": string;');
		expect(src).toContain('"coin:DBTC": {');
		expect(src).toContain('"decimals": number;');
		expect(src).toContain('"fullCoinType": string;');
		expect(src).toContain('"walrus": {');
		expect(src).toContain('"publisher": string | null;');
		// Permissive trailing index so an app may carry extra namespaces.
		expect(src).toContain('readonly [namespace: string]: { readonly [key: string]: unknown };');
	});

	it('ProvidedNetwork is never + NETWORK_NAMES is [<local>] with no committed networks', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain('export type ProvidedNetwork = never;');
		expect(src).toContain('export const NETWORK_NAMES = ["localnet"] as const;');
	});

	it('ProvidedNetwork unions the committed networks + NETWORK_NAMES leads with local', () => {
		const src = renderDeploymentStrict({
			...counterInput,
			providedNetworks: ['testnet', 'mainnet'],
		});
		expect(src).toContain('export type ProvidedNetwork = "testnet" | "mainnet";');
		expect(src).toContain(
			'export const NETWORK_NAMES = ["localnet", "testnet", "mainnet"] as const;',
		);
	});
});

describe('renderDeploymentStrict — type-level completeness (counter / no service values)', () => {
	const deploymentTs = renderDeploymentStrict({ ...counterInput, providedNetworks: ['testnet'] });

	it('a complete deployments/<net>.ts satisfies AppNetworkDeployment (clean tsc)', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/counter': '0xabc' },
		types: { '@local/counter::counter::Counter': '0xabc::counter::Counter' },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample)).toEqual([]);
	});

	it('a deployment MISSING the declared package id fails tsc', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: {},
	mvrOverrides: {
		packages: { '@local/counter': '0xabc' },
		types: { '@local/counter::counter::Counter': '0xabc::counter::Counter' },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('a deployment MISSING the declared mvr package placeholder fails tsc', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: {
		packages: {},
		types: { '@local/counter::counter::Counter': '0xabc::counter::Counter' },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('a deployment MISSING the declared mvr type tag fails tsc', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/counter': '0xabc' },
		types: {},
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('with NO declared types, a deployment OMITTING the types block satisfies tsc', () => {
		const noTypesTs = renderDeploymentStrict(noTypesInput);
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/counter': '0xabc' },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(noTypesTs, sample)).toEqual([]);
	});

	it('ProvidedDeployments is keyed by the committed network union', () => {
		const sample = `
import type { ProvidedDeployments } from './deployment';
const dep: ProvidedDeployments = {
	testnet: {
		rpc: 'https://fullnode.testnet.sui.io',
		packages: { counter: { id: '0xabc' } },
		mvrOverrides: {
			packages: { '@local/counter': '0xabc' },
			types: { '@local/counter::counter::Counter': '0xabc::counter::Counter' },
		},
	},
};
void dep;
`;
		expect(typeCheck(deploymentTs, sample)).toEqual([]);
	});

	it('a stray (non-provided) network key in ProvidedDeployments fails tsc', () => {
		const sample = `
import type { ProvidedDeployments } from './deployment';
const dep: ProvidedDeployments = {
	devnet: {
		rpc: 'x',
		packages: { counter: { id: '0xabc' } },
		mvrOverrides: {
			packages: { '@local/counter': '0xabc' },
			types: { '@local/counter::counter::Counter': '0xabc::counter::Counter' },
		},
	},
};
void dep;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});
});

describe('renderDeploymentStrict — type-level completeness (service values required)', () => {
	const deploymentTs = renderDeploymentStrict(serviceInput);

	const completeBody = `
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { trader: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/trader': '0xabc' },
		types: { '@local/trader::market::Order': '0xabc::market::Order' },
	},
	values: {
		'deepbook:DBTC_DUSDC': { poolId: '0xpool', registryId: '0xreg' },
		'coin:DBTC': { decimals: 6, fullCoinType: '0xabc::dbtc::DBTC' },
		walrus: { aggregator: 'https://agg', publisher: null },
	},`;

	it('a complete service deployment satisfies AppNetworkDeployment (clean tsc)', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {${completeBody}
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample)).toEqual([]);
	});

	it('a service deployment MISSING the values channel entirely fails tsc', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { trader: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/trader': '0xabc' },
		types: { '@local/trader::market::Order': '0xabc::market::Order' },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('a service deployment MISSING a required value key fails tsc', () => {
		// Drop `coin:DBTC.fullCoinType` — completeness must reject it.
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { trader: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/trader': '0xabc' },
		types: { '@local/trader::market::Order': '0xabc::market::Order' },
	},
	values: {
		'deepbook:DBTC_DUSDC': { poolId: '0xpool', registryId: '0xreg' },
		'coin:DBTC': { decimals: 6 },
		walrus: { aggregator: 'https://agg', publisher: null },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('a service deployment with the WRONG value TS type fails tsc', () => {
		// `decimals` typed as `number`; supply a string.
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { trader: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/trader': '0xabc' },
		types: { '@local/trader::market::Order': '0xabc::market::Order' },
	},
	values: {
		'deepbook:DBTC_DUSDC': { poolId: '0xpool', registryId: '0xreg' },
		'coin:DBTC': { decimals: 'six', fullCoinType: '0xabc::dbtc::DBTC' },
		walrus: { aggregator: 'https://agg', publisher: null },
	},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});
});
