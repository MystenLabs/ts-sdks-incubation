import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');

const readText = (relative: string): string => readFileSync(join(packageRoot, relative), 'utf8');

describe('release surface static checks', () => {
	it('packs Docker image contexts and does not export samples', () => {
		const pkg = JSON.parse(readText('package.json')) as {
			files?: string[];
			exports?: Record<string, unknown>;
		};

		expect(pkg.files).toContain('images');
		expect(pkg.files).toContain('!src/samples');
		expect(pkg.files).toContain('!dist/samples');
		expect(pkg.exports).not.toHaveProperty('./samples');
		expect(pkg.exports).toHaveProperty('./vitest/setup');
		expect(pkg.exports).toHaveProperty('./browser/setup');
	});

	it('build entries match the public release surface', () => {
		const config = readText('tsdown.config.ts');

		expect(config).toContain("'src/build-integrations/browser/setup.ts'");
		expect(config).not.toContain("'src/samples/index.ts'");
	});

	it('browser setup reaches only the slot-only runtime barrel', () => {
		const setup = readText('src/build-integrations/browser/setup.ts');
		const browserIndex = readText('src/build-integrations/browser/index.ts');

		expect(setup).toContain('../runtime/browser.ts');
		expect(setup).not.toContain('../runtime/index.ts');
		expect(browserIndex).toContain('../runtime/browser.ts');
		expect(browserIndex).not.toContain('../runtime/index.ts');
	});

	it('keeps root and substrate barrels on public vocabulary only', () => {
		const root = readText('src/index.ts');
		const substrate = readText('src/substrate/index.ts');

		for (const leaked of [
			'ContainerRuntimeService',
			'IdentityContext',
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
