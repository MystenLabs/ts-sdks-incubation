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
});
