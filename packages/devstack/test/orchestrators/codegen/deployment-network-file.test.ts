// `dump-deployment --network` typed-file emitter tests.
//
// `renderNetworkDeploymentFile` emits the committed `deployments/<net>.ts` a
// real-network deploy ships — `export const deployment = {…} satisfies
// AppNetworkDeployment`. These tests assert the rendered SHAPE (string-level:
// the `import type`, the `satisfies`, no `accounts`/`local`) AND that the
// emitted file actually ROUND-TRIPS: it `tsc`-checks clean against the strict
// `deployment.ts` the same app would generate (an in-memory program), so the
// `satisfies` is exercised, not just asserted by substring.

import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

import { renderNetworkDeploymentFile } from '../../../src/orchestrators/codegen/deployment-network-file.ts';
import type { NetworkDeployment } from '../../../src/orchestrators/codegen/deployment.ts';
import { renderDeploymentStrict } from '../../../src/orchestrators/codegen/deployment-strict.ts';

// A minimal stand-in for the emitted `config-runtime.ts`'s `NetworkDeployment`
// type — enough for the strict `deployment.ts` to import + narrow.
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

/** Type-check a rendered `deployment.ts` (rewired to import the stub) plus a
 *  caller-supplied `deployments/<net>.ts` source, in-memory. The emitted file's
 *  `'../src/generated/deployment.js'` import is rewritten to `'./deployment'`
 *  so the in-memory program resolves it. Returns semantic diagnostics (empty ⇒
 *  compiles clean). */
const typeCheck = (deploymentTs: string, sampleTs: string): ReadonlyArray<string> => {
	const files: Record<string, string> = {
		'/config-runtime.ts': CONFIG_RUNTIME_STUB,
		'/deployment.ts': deploymentTs.replace("from './config-runtime.js'", "from './config-runtime'"),
		'/sample.ts': sampleTs.replace("from '../src/generated/deployment.js'", "from './deployment'"),
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

/** A fully-resolved `NetworkDeployment` unit (the shape a `networks.<net>`
 *  envelope entry carries) — counter package + a values channel. */
const testnetUnit: NetworkDeployment = {
	network: 'testnet',
	rpc: 'https://fullnode.testnet.sui.io',
	chainId: '4c78adac',
	faucet: 'https://faucet.testnet.sui.io',
	local: true, // dev marker — the emitter must DROP this.
	packages: { counter: { id: '0xabc', objects: { registry: '0xreg' } } },
	mvrOverrides: { '@local/counter': '0xabc' },
	values: { 'coin:managed_coin': { treasuryCapId: '0xcap' } },
};

describe('renderNetworkDeploymentFile — shape', () => {
	const rendered = renderNetworkDeploymentFile('testnet', testnetUnit);
	if (!rendered.ok) throw new Error(`render failed: ${rendered.error.detail}`);
	const src = rendered.text;

	it('imports AppNetworkDeployment from the generated deployment.ts', () => {
		expect(src).toContain(
			"import type { AppNetworkDeployment } from '../src/generated/deployment.js';",
		);
	});

	it('emits `export const deployment = {…} satisfies AppNetworkDeployment`', () => {
		expect(src).toContain('export const deployment = {');
		expect(src).toContain('} satisfies AppNetworkDeployment;');
	});

	it('carries the network name + load-bearing rpc + packages + mvrOverrides', () => {
		expect(src).toContain("network: 'testnet'");
		expect(src).toContain("rpc: 'https://fullnode.testnet.sui.io'");
		expect(src).toContain("'@local/counter': '0xabc'");
		expect(src).toContain('counter:');
	});

	it('omits dev-only accounts AND the local marker from the body', () => {
		// Accounts are envelope-level (never a per-network unit field) — and
		// `local` is a dev-stack flag a committed deployment must not carry. Check
		// the rendered BODY only (the header prose mentions "accounts").
		const body = src.slice(src.indexOf('export const deployment'));
		expect(body).not.toContain('accounts');
		expect(body).not.toContain('local:');
	});

	it('drops absent optional fields when the unit omits them', () => {
		const minimal = renderNetworkDeploymentFile('devnet', {
			network: 'devnet',
			rpc: 'https://fullnode.devnet.sui.io',
			packages: {},
			mvrOverrides: {},
		});
		if (!minimal.ok) throw new Error('render failed');
		expect(minimal.text).not.toContain('chainId');
		expect(minimal.text).not.toContain('faucet');
		expect(minimal.text).not.toContain('values');
	});
});

describe('renderNetworkDeploymentFile — round-trips against the generated deployment.ts', () => {
	// The strict `deployment.ts` the SAME app would generate (counter package +
	// its MVR placeholder), declaring `testnet` as a committed network.
	const deploymentTs = renderDeploymentStrict({
		localNetworkName: 'localnet',
		packageNames: ['counter'],
		mvrPlaceholders: ['@local/counter'],
		providedNetworks: ['testnet'],
	});

	it('the emitted deployments/testnet.ts satisfies AppNetworkDeployment (clean tsc)', () => {
		const rendered = renderNetworkDeploymentFile('testnet', testnetUnit);
		if (!rendered.ok) throw new Error('render failed');
		expect(typeCheck(deploymentTs, rendered.text)).toEqual([]);
	});

	it('an emitted file MISSING the declared package id fails tsc', () => {
		// Strip the counter package — completeness must reject it.
		const rendered = renderNetworkDeploymentFile('testnet', {
			...testnetUnit,
			packages: {},
		});
		if (!rendered.ok) throw new Error('render failed');
		expect(typeCheck(deploymentTs, rendered.text).length).toBeGreaterThan(0);
	});
});
