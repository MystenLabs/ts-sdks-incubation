// Unit tests for the fence stripper against SYNTHETIC in-memory fixtures.
// These do NOT depend on the authored template's content; they pin the marker
// semantics the design specifies so the scaffolder's strip logic is verified
// independently of the template.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALL_PLUGINS, PLUGIN_MANIFEST, type PluginId } from '../src/plugin-manifest.js';
import { assertFencesBalanced, stripFences, stripPlugins } from '../src/strip.js';

/** A synthetic source file exercising core + seal + walrus fences. The core
 *  lines are unfenced (always kept). */
const FIXTURE = [
	"import { CounterPanel } from './panels/CounterPanel.js';",
	'// devstack:begin walrus',
	"import { WalrusPanel } from './panels/WalrusPanel.js';",
	'// devstack:end walrus',
	'// devstack:begin seal',
	"import { SealPanel } from './panels/SealPanel.js';",
	'// devstack:end seal',
	'',
	'const panels = [',
	'\tCounterPanel,',
	'\t// devstack:begin walrus',
	'\tWalrusPanel,',
	'\t// devstack:end walrus',
	'\t// devstack:begin seal',
	'\tSealPanel,',
	'\t// devstack:end seal',
	'];',
	'',
].join('\n');

function set(...ids: PluginId[]): Set<PluginId> {
	return new Set<PluginId>(['core', ...ids]);
}

describe('stripFences', () => {
	it('keeps selected plugin bodies (sans fence lines) and drops unselected blocks', () => {
		const { text, empty } = stripFences(FIXTURE, set('walrus'));
		expect(empty).toBe(false);
		// walrus kept...
		expect(text).toContain("import { WalrusPanel } from './panels/WalrusPanel.js';");
		expect(text).toContain('\tWalrusPanel,');
		// ...seal dropped...
		expect(text).not.toContain('SealPanel');
		// ...core always kept...
		expect(text).toContain("import { CounterPanel } from './panels/CounterPanel.js';");
		expect(text).toContain('\tCounterPanel,');
		// ...and NO fence lines survive.
		expect(text).not.toContain('devstack:begin');
		expect(text).not.toContain('devstack:end');
	});

	it('drops all optional blocks when only core is selected', () => {
		const { text } = stripFences(FIXTURE, set());
		expect(text).not.toContain('WalrusPanel');
		expect(text).not.toContain('SealPanel');
		expect(text).toContain('CounterPanel');
		expect(text).not.toContain('devstack:');
	});

	it('keeps both optional blocks when both selected', () => {
		const { text } = stripFences(FIXTURE, set('walrus', 'seal'));
		expect(text).toContain('WalrusPanel');
		expect(text).toContain('SealPanel');
		expect(text).not.toContain('devstack:');
	});

	it('reports content-empty when every line was fenced away', () => {
		const onlyOptional = [
			'// devstack:begin walrus',
			"import { WalrusPanel } from './panels/WalrusPanel.js';",
			'// devstack:end walrus',
		].join('\n');
		const { empty } = stripFences(onlyOptional, set());
		expect(empty).toBe(true);
	});

	it('preserves trailing-newline presence', () => {
		const withNl = stripFences('const x = 1;\n', set());
		expect(withNl.text).toBe('const x = 1;\n');
		const noNl = stripFences('const x = 1;', set());
		expect(noNl.text).toBe('const x = 1;');
	});

	it('throws on an unmatched end fence', () => {
		expect(() => stripFences('// devstack:end walrus\n', set('walrus'))).toThrow(/unmatched/);
	});

	it('throws on an unclosed begin fence', () => {
		expect(() => stripFences('// devstack:begin walrus\nfoo\n', set('walrus'))).toThrow(
			/unclosed/,
		);
	});

	it('throws on a mismatched (interleaved) fence', () => {
		const bad = [
			'// devstack:begin walrus',
			'// devstack:end seal',
			'// devstack:begin seal',
			'// devstack:end walrus',
		].join('\n');
		expect(() => stripFences(bad, set('walrus', 'seal'))).toThrow(/mismatched/);
	});
});

describe('assertFencesBalanced', () => {
	it('passes on balanced fences', () => {
		expect(() => assertFencesBalanced(FIXTURE, 'fixture')).not.toThrow();
	});
	it('throws on imbalance', () => {
		expect(() => assertFencesBalanced('// devstack:begin walrus\n', 'fixture')).toThrow(
			/unclosed/,
		);
	});
});

describe('stripPlugins (end-to-end over a temp app dir)', () => {
	function makeApp(): string {
		const dir = mkdtempSync(join(tmpdir(), 'create-devstack-app-strip-'));
		// A shared fenced file (App.tsx-like).
		writeFileSync(join(dir, 'App.tsx'), FIXTURE);
		// Plugin-owned files (panels/libs/specs). Use nested dirs.
		writeFileSync(makeDir(dir, 'src/panels/WalrusPanel.tsx'), 'export const WalrusPanel = 1;\n');
		writeFileSync(makeDir(dir, 'src/lib/walrus.ts'), 'export const storeBlob = 1;\n');
		writeFileSync(makeDir(dir, 'e2e/walrus.spec.ts'), 'test("walrus", () => {});\n');
		writeFileSync(makeDir(dir, 'src/panels/SealPanel.tsx'), 'export const SealPanel = 1;\n');
		writeFileSync(makeDir(dir, 'src/lib/seal.ts'), 'export const encryptForSealId = 1;\n');
		writeFileSync(makeDir(dir, 'e2e/seal.spec.ts'), 'test("seal", () => {});\n');
		// A seal-owned move dir.
		writeFileSync(makeDir(dir, 'move/vault/Move.toml'), '[package]\nname = "vault"\n');
		// package.json with superset optional deps.
		writeFileSync(
			join(dir, 'package.json'),
			`${JSON.stringify(
				{
					name: 'fixture',
					dependencies: {
						'@mysten/sui': '^2.0.0',
						'@mysten/walrus': '^1.1.7',
						'@mysten/walrus-wasm': '^0.2.0',
						'@mysten/seal': '^1.1.1',
						'@mysten/deepbook-v3': '^1.3.3',
					},
				},
				null,
				'\t',
			)}\n`,
		);
		return dir;
	}

	function makeDir(root: string, rel: string): string {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		return full;
	}

	function readPkg(dir: string): { dependencies?: Record<string, string> } {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	}

	it('keeps everything when all plugins selected', () => {
		const dir = makeApp();
		try {
			stripPlugins(dir, new Set(ALL_PLUGINS));
			const deps = readPkg(dir).dependencies ?? {};
			expect(deps['@mysten/walrus']).toBeDefined();
			expect(deps['@mysten/seal']).toBeDefined();
			expect(deps['@mysten/deepbook-v3']).toBeDefined();
			// Fences removed from shared file even when all selected.
			const app = readFileSync(join(dir, 'App.tsx'), 'utf8');
			expect(app).not.toContain('devstack:');
			expect(app).toContain('WalrusPanel');
			expect(app).toContain('SealPanel');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('strips seal: removes files, dir, dep, fenced lines — no leftovers', () => {
		const dir = makeApp();
		try {
			stripPlugins(dir, set('walrus')); // core + walrus, NOT seal/deepbook
			const deps = readPkg(dir).dependencies ?? {};
			// seal + deepbook deps gone; walrus kept.
			expect(deps['@mysten/seal']).toBeUndefined();
			expect(deps['@mysten/deepbook-v3']).toBeUndefined();
			expect(deps['@mysten/walrus']).toBeDefined();
			expect(deps['@mysten/walrus-wasm']).toBeDefined();
			// seal owned files/dir gone; walrus owned files kept.
			expect(existsAt(dir, 'src/panels/SealPanel.tsx')).toBe(false);
			expect(existsAt(dir, 'src/lib/seal.ts')).toBe(false);
			expect(existsAt(dir, 'e2e/seal.spec.ts')).toBe(false);
			expect(existsAt(dir, 'move/vault/Move.toml')).toBe(false);
			expect(existsAt(dir, 'src/panels/WalrusPanel.tsx')).toBe(true);
			// shared file: seal lines gone, walrus lines kept, no fences/imports dangling.
			const app = readFileSync(join(dir, 'App.tsx'), 'utf8');
			expect(app).not.toContain('SealPanel');
			expect(app).toContain('WalrusPanel');
			expect(app).not.toContain('devstack:');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('minimal (core only) strips every optional plugin and all optional deps', () => {
		const dir = makeApp();
		try {
			stripPlugins(dir, set());
			const deps = readPkg(dir).dependencies ?? {};
			expect(deps['@mysten/walrus']).toBeUndefined();
			expect(deps['@mysten/walrus-wasm']).toBeUndefined();
			expect(deps['@mysten/seal']).toBeUndefined();
			expect(deps['@mysten/deepbook-v3']).toBeUndefined();
			expect(deps['@mysten/sui']).toBeDefined(); // core dep untouched
			const app = readFileSync(join(dir, 'App.tsx'), 'utf8');
			expect(app).not.toContain('WalrusPanel');
			expect(app).not.toContain('SealPanel');
			expect(app).toContain('CounterPanel');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('tolerates a plugin whose owned files are missing (rm -f semantics)', () => {
		const dir = makeApp();
		try {
			// deepbook owns files that were never created in the fixture — strip
			// must not throw on the missing paths.
			expect(() => stripPlugins(dir, set('walrus', 'seal'))).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a selected set without 'core'", () => {
		const dir = makeApp();
		try {
			expect(() => stripPlugins(dir, new Set<PluginId>(['walrus']))).toThrow(/core/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function existsAt(dir: string, rel: string): boolean {
	return existsSync(join(dir, rel));
}

describe('manifest sanity', () => {
	it('every optional plugin manifest names a panel/lib/spec', () => {
		for (const id of ALL_PLUGINS) {
			if (id === 'core') continue;
			const entry = PLUGIN_MANIFEST[id];
			expect(entry.files.length).toBeGreaterThan(0);
			expect(entry.deps.length).toBeGreaterThan(0);
		}
	});
});
