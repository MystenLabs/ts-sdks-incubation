import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');

const readText = (relative: string): string => readFileSync(join(packageRoot, relative), 'utf8');

type PackageExportTarget = {
	types?: string;
	import?: string;
};

type PackageJson = {
	files?: string[];
	exports?: Record<string, PackageExportTarget>;
	types?: string;
};

type PackDryRunEntry = {
	files: Array<{ path: string }>;
};

const PACK_DRY_RUN_TIMEOUT_MS = 120_000;
let cachedPackFiles: string[] | null = null;

// Every subpath listed here MUST appear in `pkg.exports`. Stripping any
// of these silently breaks a real consumer wiring; the spot-check style
// (one explicit `toHaveProperty('./vitest/setup')`) didn't pin the rest.
const REQUIRED_EXPORTS: ReadonlyArray<readonly [string, string]> = [
	// Root barrel — `import { ... } from '@mysten-incubation/devstack'`.
	['.', 'root barrel — plugin-author surface + runtime services'],
	// Vitest preset barrel (re-exports the helpers).
	['./vitest', 'vitest preset barrel'],
	// Vitest setup file consumed by `setupFiles` in user vitest configs.
	['./vitest/setup', 'vitest setup file (referenced by vitest preset)'],
	// Playwright preset barrel (re-exports config helpers).
	['./playwright', 'playwright preset barrel'],
	// Playwright global-setup file referenced by `playwright/config.ts`
	// `DEFAULT_GLOBAL_SETUP`. Stripping this silently breaks the default
	// playwright preset for every consumer.
	['./playwright/global-setup', 'playwright global setup (DEFAULT_GLOBAL_SETUP target)'],
	// Build-integration runtime surface consumed by user app code that
	// reads the stack context emitted by `supervise()`.
	['./runtime', 'build-integration runtime — stack-context reader'],
];

// Subpaths that MUST NOT be exported. Devstack consumers must NEVER
// import from devstack internals (ARCHITECTURE: public surface is the
// root barrel + the named subpaths above; everything else is private).
const FORBIDDEN_EXPORTS: ReadonlyArray<readonly [string, string]> = [
	['./src', 'source tree is private — consumers import compiled dist'],
	['./substrate', 'substrate is internal — see ARCHITECTURE public-surface rules'],
	['./orchestrators', 'orchestrators are internal'],
	['./plugins', 'plugin internals are private — consumers import named plugins from root barrel'],
	['./cli', 'CLI is a `bin`, not an importable module'],
	['./dist', 'never expose the build output root directly'],
];

const readPackageJson = (): PackageJson => JSON.parse(readText('package.json')) as PackageJson;

const exportedTargets = () => {
	const pkg = readPackageJson();
	return Object.entries(pkg.exports ?? {}).map(([specifier, target]) => ({
		specifier,
		...target,
	}));
};

const packFiles = (): string[] => {
	if (cachedPackFiles !== null) return cachedPackFiles;
	const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
		cwd: packageRoot,
		encoding: 'utf8',
		timeout: PACK_DRY_RUN_TIMEOUT_MS,
	});
	const parsed = JSON.parse(output) as PackDryRunEntry[];
	const pack = parsed[0];
	if (!pack) {
		throw new Error('npm pack --dry-run --json returned no package entries');
	}
	cachedPackFiles = pack.files.map((file) => file.path);
	return cachedPackFiles;
};

describe('release surface static checks', () => {
	it('packs Docker image contexts and does not export samples', () => {
		const pkg = readPackageJson();

		expect(pkg.files).toContain('dist');
		expect(pkg.files).toContain('images');
		expect(pkg.files).toContain('!dist/samples');
		expect(pkg.files).toContain('!dist/node_modules');
		expect(pkg.files).not.toContain('src');
		expect(pkg.exports).not.toHaveProperty('./samples');
		expect(pkg.exports).toHaveProperty('./vitest/setup');
		expect(pkg.exports).not.toHaveProperty('./vite');
		expect(pkg.exports).not.toHaveProperty('./browser');
		expect(pkg.exports).not.toHaveProperty('./browser/setup');
	});

	it('exposes every required public subpath', () => {
		const pkg = readPackageJson();
		const exports = pkg.exports ?? {};
		for (const [specifier, why] of REQUIRED_EXPORTS) {
			expect(exports, `missing ${specifier} (${why})`).toHaveProperty(specifier);
		}
	});

	it('does not expose internal subpaths', () => {
		const pkg = readPackageJson();
		const exports = pkg.exports ?? {};
		for (const [specifier, why] of FORBIDDEN_EXPORTS) {
			expect(exports, `${specifier} must remain private (${why})`).not.toHaveProperty(specifier);
		}
	});

	it('points every public export at built JavaScript and declaration files', () => {
		const pkg = readPackageJson();

		expect(pkg.types).toBe('./dist/index.d.mts');

		for (const { specifier, import: importPath, types } of exportedTargets()) {
			expect(importPath, `${specifier} import`).toMatch(/^\.\/dist\/.*\.mjs$/);
			expect(types, `${specifier} types`).toMatch(/^\.\/dist\/.*\.d\.mts$/);
			expect(existsSync(join(packageRoot, importPath?.slice(2) ?? '')), `${specifier} import`).toBe(
				true,
			);
			expect(existsSync(join(packageRoot, types?.slice(2) ?? '')), `${specifier} types`).toBe(true);
		}
	});

	it('keeps the executable shebang out of declaration files', () => {
		expect(readText('dist/cli/main.mjs')).toMatch(/^#!\/usr\/bin\/env node\n/);
		expect(readText('dist/index.d.mts')).not.toMatch(/^#!/);
		expect(readText('dist/cli/main.d.mts')).not.toMatch(/^#!/);
	});

	it(
		'keeps declarations on public package specifiers',
		() => {
			const badSpecifier =
				/(?:node_modules\/(?:\.pnpm\/effect@[^/]+\/node_modules\/)?effect\/dist\/|effect\/[^"']+\.js|\.pnpm\/effect)/;

			for (const file of packFiles().filter((file) => file.endsWith('.d.mts'))) {
				expect(readText(file), file).not.toMatch(badSpecifier);
			}
		},
		PACK_DRY_RUN_TIMEOUT_MS,
	);

	it(
		'pack dry-run includes runtime assets and excludes generated artifacts',
		() => {
			const files = packFiles();

			for (const imageFile of [
				'images/_shared/signal-forward.sh',
				'images/postgres/Dockerfile',
				'images/seal/Dockerfile',
				'images/seal/entrypoint.sh',
				'images/sui/Dockerfile',
				'images/sui/entrypoint.sh',
				'images/walrus/Dockerfile',
				'images/walrus/deploy-walrus.sh',
				'images/walrus/run-walrus.sh',
			]) {
				expect(files).toContain(imageFile);
			}

			for (const { specifier, import: importPath, types } of exportedTargets()) {
				expect(files, `${specifier} import`).toContain(importPath?.slice(2));
				expect(files, `${specifier} types`).toContain(types?.slice(2));
			}

			expect(files.some((file) => file.startsWith('src/'))).toBe(false);
			expect(files.some((file) => file.startsWith('src/generated/'))).toBe(false);
			expect(files.some((file) => file.startsWith('src/samples/'))).toBe(false);
			expect(files.some((file) => file.startsWith('dist/samples/'))).toBe(false);
			expect(files.some((file) => file.startsWith('dist/node_modules/'))).toBe(false);
		},
		PACK_DRY_RUN_TIMEOUT_MS,
	);

	it('build entries match the public release surface', () => {
		const config = readText('tsdown.config.ts');

		expect(config).not.toContain("'src/build-integrations/vite/index.ts'");
		expect(config).not.toContain("'src/build-integrations/browser/index.ts'");
		expect(config).not.toContain("'src/build-integrations/browser/setup.ts'");
		expect(config).not.toContain("'src/samples/index.ts'");
	});

	it('does not expose dapp-kit slot writer helpers from the runtime subpath', () => {
		const runtimeIndex = readText('src/build-integrations/runtime/index.ts');

		expect(runtimeIndex).not.toContain('writeDAppKitSlot');
		expect(runtimeIndex).not.toContain('readDAppKitSlot');
		expect(runtimeIndex).not.toContain('clearDAppKitSlot');
		expect(runtimeIndex).not.toContain("from './dapp-kit-slot.ts'");
	});

	it('exposes plugin-author runtime services from the root barrel', async () => {
		const rootSpecifier: string = '@mysten-incubation/devstack';
		const root = (await import(rootSpecifier)) as Record<string, unknown>;

		expect(root.ContainerRuntimeService).toBeDefined();
		expect(root.IdentityContext).toBeDefined();
	}, 20_000);

	it('keeps root and substrate barrels on public vocabulary only', () => {
		const root = readText('src/index.ts');
		const substrate = readText('src/substrate/index.ts');

		for (const leaked of [
			'PluginErrorContribution',
			'LifecycleFact',
			'chainProbeFor',
			'ERROR_TAGS',
			'CoinRegistryService',
			'layerCoinRegistry',
			'discoverCoinsFromPublish',
			'performMint',
			'makeWalletRoutable',
			'startHttpServer',
			'makeWalletCodegen',
			'makeSealManagerTag',
			'sealManagerTagId',
			'SealManagerTagId',
			'ActionReceiptSchema',
			'signAndExecute',
			'DynamicDiscriminator',
			'StaticDiscriminator',
			'ActionObjectChange',
			'SuiExternalOptions',
			'chainOverride',
			'ForkMeta',
			'SeedObjectsAccumulator',
			'WaitForTransactionsReady',
			'PackageCaptureCallback',
			'PackageCaptureMap',
			'LocalPackagePublishOutput',
			'PackagePublishObjectChange',
			'PickCreatedByTypeOptions',
			'pickCreatedByType',
			'requestFundsOnce',
			'requestFundsWithRetry',
			'enableRouter',
			'WALLET_ACCOUNTS_ALL',
			'WalletAccountsAll',
			'sealLocalKeygenStrict',
			'DeepbookLocalOptions',
			'_localRefused',
		]) {
			expect(root).not.toContain(leaked);
			expect(substrate).not.toContain(leaked);
		}

		expect(root).toContain('type SealResolved');

		expect(substrate).not.toMatch(/^export \* from/m);
		for (const privateModule of [
			'./cross-process.ts',
			'./events.ts',
			'./identity.ts',
			'./projection.ts',
			'./state-store.ts',
		]) {
			expect(substrate).not.toContain(privateModule);
		}
	});

	it('pins build-integration manifest version to the writer version', () => {
		const writer = readText('src/substrate/runtime/manifest/manifest.ts');
		const reader = readText('src/build-integrations/runtime/read-stack-context.ts');

		const writerVersion = writer.match(/CURRENT_MANIFEST_VERSION = (\d+) as const/);
		const readerVersion = reader.match(/CONSUMER_MANIFEST_VERSION = (\d+) as const/);

		expect(writerVersion?.[1]).toBeDefined();
		expect(readerVersion?.[1]).toBe(writerVersion?.[1]);
		expect(reader).toContain('ManifestEnvelopeSchema');
		expect(reader).toContain('type ManifestEnvelope');
		expect(reader).toContain('../../substrate/manifest.ts');
	});
});
