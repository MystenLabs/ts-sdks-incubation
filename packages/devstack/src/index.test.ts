// Public-API surface contract. Imports every named value export from the
// root barrel and asserts the set matches a pinned list. Catches
// accidental removals or unintended additions to the package's public
// surface — when the surface changes intentionally, update PUBLIC_EXPORTS
// in this file and the test stays green.

import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import * as publicApi from './index.js';

const PUBLIC_EXPORTS = [
	// Compose entry
	'devstack',
	// LayeredTag factories
	'Account',
	'Action',
	'Codegen',
	'DEFAULT_CODEGEN_OUTPUT',
	'Deepbook',
	'DeepbookMarketMaker',
	// Phase 4-5 deepbook extensions
	'DeepbookMargin',
	'DeepbookIndexer',
	'DeepbookServer',
	'DeepbookMintDEEP',
	'DeepbookMintUSDC',
	'VendorDeepbook',
	'USDC_MARGIN_DEFAULTS',
	'SUI_MARGIN_DEFAULTS',
	'DEFAULT_POOL_RISK_CONFIG',
	'Dev',
	'KnownPackage',
	'Package',
	'Postgres',
	'PostgresTag',
	// Phase 1 — Pyth oracle primitives
	'Pyth',
	'PythTag',
	'PythPusher',
	'pythMid',
	'SUI_PRICE_FEED_ID',
	'DEEP_PRICE_FEED_ID',
	'USDC_PRICE_FEED_ID',
	'Seal',
	'Sui',
	'Wallet',
	'Walrus',
	// Manifest wire-protocol surface
	'WalletHttpPath',
	// Helpers
	'Coin',
	// Tagged error types
	'AccountError',
	'CodegenError',
	'CoinAmbiguousError',
	'CoinNotFoundError',
	'DeepbookError',
	'DockerError',
	'FaucetRequestError',
	'HostProcessError',
	'ManifestError',
	'PublishError',
	'SealError',
	'SuiError',
	'WalletAppError',
	'WalrusError',
	// Interface tag classes
	'SealKeyServerTag',
] as const;

describe('public API surface', () => {
	it('exports exactly the pinned set of named values', () => {
		const actual = Object.keys(publicApi).sort();
		const expected = [...PUBLIC_EXPORTS].sort();
		expect(actual).toEqual(expected);
	});
});

// Phase -1 meta-test: enforce the "gRPC-default, no JSON-RPC" policy by
// walking the package source tree and asserting zero `@mysten/sui/jsonRpc`
// imports survive outside the allowlist. The oxlint rule in
// `.oxlintrc.json::overrides` is the line of first defense (catches on
// `pnpm lint`); this test is the belt-and-suspenders so a CI run that
// skips lint still fails on a regression. Allowlist is currently empty —
// add a `// devstack-allow:jsonRpc` comment on any new exception and
// extend `ALLOWED_JSONRPC_PATHS` here.
const PACKAGE_SRC_ROOT = nodePath.join(import.meta.dirname, '..', 'src');
const JSONRPC_IMPORT_RE = /from\s+['"]@mysten\/sui\/jsonRpc['"]/;
const ALLOWED_JSONRPC_PATHS: ReadonlyArray<string> = [];

async function* walkSourceFiles(dir: string): AsyncIterable<string> {
	const entries = await nodeFs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = nodePath.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip generated bundles + test-build artifacts.
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
				continue;
			}
			yield* walkSourceFiles(full);
		} else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
			yield full;
		}
	}
}

describe('Phase -1 gRPC-only invariant', () => {
	it('no-jsonrpc-imports: production source has zero @mysten/sui/jsonRpc imports outside the allowlist', async () => {
		const offenders: string[] = [];
		for await (const file of walkSourceFiles(PACKAGE_SRC_ROOT)) {
			const rel = nodePath.relative(PACKAGE_SRC_ROOT, file);
			if (ALLOWED_JSONRPC_PATHS.includes(rel)) continue;
			const contents = await nodeFs.readFile(file, 'utf8');
			if (JSONRPC_IMPORT_RE.test(contents)) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
