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

const readPackageJson = (): PackageJson => JSON.parse(readText('package.json')) as PackageJson;

const exportedTargets = () => {
	const pkg = readPackageJson();
	return Object.entries(pkg.exports ?? {}).map(([specifier, target]) => ({
		specifier,
		...target,
	}));
};

const packFiles = (): string[] => {
	const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
		cwd: packageRoot,
		encoding: 'utf8',
	});
	const parsed = JSON.parse(output) as PackDryRunEntry[];
	const pack = parsed[0];
	if (!pack) {
		throw new Error('npm pack --dry-run --json returned no package entries');
	}
	return pack.files.map((file) => file.path);
};

describe('release surface static checks', () => {
	it('packs Docker image contexts and does not export samples', () => {
		const pkg = readPackageJson();

		expect(pkg.files).toContain('images');
		expect(pkg.files).toContain('!src/generated');
		expect(pkg.files).toContain('!src/samples');
		expect(pkg.files).toContain('!dist/samples');
		expect(pkg.files).toContain('!dist/node_modules');
		expect(pkg.exports).not.toHaveProperty('./samples');
		expect(pkg.exports).toHaveProperty('./vitest/setup');
		expect(pkg.exports).toHaveProperty('./browser/setup');
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

	it('pack dry-run includes runtime assets and excludes generated artifacts', () => {
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

		expect(files.some((file) => file.startsWith('src/generated/'))).toBe(false);
		expect(files.some((file) => file.startsWith('src/samples/'))).toBe(false);
		expect(files.some((file) => file.startsWith('dist/samples/'))).toBe(false);
		expect(files.some((file) => file.startsWith('dist/node_modules/'))).toBe(false);
	}, 20_000);

	it('build entries match the public release surface', () => {
		const config = readText('tsdown.config.ts');

		expect(config).toContain("'src/build-integrations/browser/setup.ts'");
		expect(config).not.toContain("'src/samples/index.ts'");
	});

	it('browser setup reaches only the slot-only runtime barrel', () => {
		const setup = readText('src/build-integrations/browser/setup.ts');
		const setupGlobals = readText('src/build-integrations/browser/setup-globals.ts');
		const browserIndex = readText('src/build-integrations/browser/index.ts');

		expect(setupGlobals).toContain('../runtime/browser.ts');
		expect(setupGlobals).not.toContain('../runtime/index.ts');
		expect(setup).toContain('./setup-globals.ts');
		expect(setup).not.toContain('../runtime/index.ts');
		expect(browserIndex).toContain('../runtime/browser.ts');
		expect(browserIndex).not.toContain('../runtime/index.ts');
		expect(browserIndex).toContain('./setup-globals.ts');
		expect(browserIndex).not.toContain('./setup.ts');
	});

	it('imports the public browser barrel without running browser setup', async () => {
		Reflect.deleteProperty(globalThis, '__devstackDAppKit__');

		const browserSpecifier: string = '@mysten-incubation/devstack/browser';
		const browser = (await import(browserSpecifier)) as Record<string, unknown>;

		expect(browser.defineDevstackBrowserConfig).toBeTypeOf('function');
		expect(browser.setupDevstackBrowserGlobals).toBeTypeOf('function');
		expect(Object.hasOwn(globalThis, '__devstackDAppKit__')).toBe(false);
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
			'coinRegistryLayer',
			'discoverCoinsFromPublish',
			'performMint',
			'makeWalletRoutable',
			'startHttpServer',
			'makeWalletCodegen',
			'makeSealManagerTag',
			'sealManagerTagId',
			'SealManagerTagId',
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
		expect(reader).toContain('ManifestEnvelopeSchema, type ManifestEnvelope');
		expect(reader).toContain('../../substrate/manifest.ts');
	});
});
