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

import {
	renderDeploymentStrict,
	type DeploymentStrictInput,
} from '../../../src/orchestrators/codegen/deployment-strict.ts';

// A minimal stand-in for the emitted `config-runtime.ts`'s `NetworkDeployment`
// type — enough for the strict `deployment.ts` to import + narrow. Mirrors the
// real interface's load-bearing fields.
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
	readonly mvrOverrides: { readonly [mvrPlaceholder: string]: string };
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

const counterInput: DeploymentStrictInput = {
	localNetworkName: 'localnet',
	packageNames: ['counter'],
	mvrPlaceholders: ['@local/counter'],
	providedNetworks: [],
};

describe('renderDeploymentStrict — shape', () => {
	it('emits AppPackages exhaustive over declared package names', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain('export interface AppPackages {');
		expect(src).toContain('readonly "counter": { readonly id: string;');
	});

	it('requires every declared MVR placeholder in mvrOverrides', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain('"@local/counter": string;');
	});

	it('AppNetworkDeployment omits accounts (hoisted to the envelope)', () => {
		const src = renderDeploymentStrict(counterInput);
		expect(src).toContain("Omit<NetworkDeployment, 'packages' | 'mvrOverrides'>");
		expect(src).not.toContain('accounts:');
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

describe('renderDeploymentStrict — type-level completeness', () => {
	const deploymentTs = renderDeploymentStrict({ ...counterInput, providedNetworks: ['testnet'] });

	it('a complete deployments/<net>.ts satisfies AppNetworkDeployment (clean tsc)', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: { '@local/counter': '0xabc' },
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
	mvrOverrides: { '@local/counter': '0xabc' },
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('a deployment MISSING the declared mvr placeholder fails tsc', () => {
		const sample = `
import type { AppNetworkDeployment } from './deployment';
export const deployment = {
	rpc: 'https://fullnode.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: {},
} satisfies AppNetworkDeployment;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});

	it('ProvidedDeployments is keyed by the committed network union', () => {
		const sample = `
import type { ProvidedDeployments } from './deployment';
const dep: ProvidedDeployments = {
	testnet: {
		rpc: 'https://fullnode.testnet.sui.io',
		packages: { counter: { id: '0xabc' } },
		mvrOverrides: { '@local/counter': '0xabc' },
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
		mvrOverrides: { '@local/counter': '0xabc' },
	},
};
void dep;
`;
		expect(typeCheck(deploymentTs, sample).length).toBeGreaterThan(0);
	});
});
