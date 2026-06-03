// Unit tests for the COMPOSE mechanism (replaces the old fence stripper).
//
// Two layers:
//   1. Pure barrel rendering — for each subset, `renderPanelsBarrel` /
//      `renderPluginsBarrel` import + list exactly the selected plugins and
//      nothing else.
//   2. End-to-end over a synthetic superset app dir — `composePlugins` deletes
//      unselected files/dirs/deps, regenerates the barrels, and leaves no
//      dangling references for ANY subset.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	composePlugins,
	renderPanelsBarrel,
	renderPluginsBarrel,
} from '../src/compose.js';
import {
	ALL_PLUGINS,
	OPTIONAL_PLUGINS,
	PLUGIN_MANIFEST,
	type PluginId,
} from '../src/plugin-manifest.js';

function set(...ids: PluginId[]): Set<PluginId> {
	return new Set<PluginId>(['core', ...ids]);
}

/** Every subset of the optional plugins, paired with a readable label. */
const SUBSETS: ReadonlyArray<{ label: string; selected: Set<PluginId> }> = [
	{ label: 'core', selected: set() },
	{ label: '+walrus', selected: set('walrus') },
	{ label: '+seal', selected: set('seal') },
	{ label: '+deepbook', selected: set('deepbook') },
	{ label: 'all', selected: set('walrus', 'seal', 'deepbook') },
];

describe('renderPanelsBarrel', () => {
	for (const { label, selected } of SUBSETS) {
		it(`[${label}] imports + lists exactly the selected panels`, () => {
			const out = renderPanelsBarrel(selected);
			// Core panel always present.
			expect(out).toContain("import { CounterPanel } from './panels/CounterPanel.js';");
			expect(out).toContain('CounterPanel,');
			for (const id of OPTIONAL_PLUGINS) {
				const panel = PLUGIN_MANIFEST[id].panel;
				if (selected.has(id)) {
					expect(out).toContain(`import { ${panel} }`);
					expect(out).toContain(`\t${panel},`);
				} else {
					expect(out).not.toContain(panel);
				}
			}
			// No fence markers ever (the mechanism is fence-free).
			expect(out).not.toContain('devstack:');
		});
	}
});

describe('renderPluginsBarrel', () => {
	for (const { label, selected } of SUBSETS) {
		it(`[${label}] imports + lists exactly the selected wiring modules`, () => {
			const out = renderPluginsBarrel(selected);
			expect(out).toContain('export const OPTIONAL_PLUGINS');
			for (const id of OPTIONAL_PLUGINS) {
				const mod = PLUGIN_MANIFEST[id].configModule;
				if (selected.has(id)) {
					expect(out).toContain(`import { ${mod} } from './${id}.js';`);
					expect(out).toContain(`\t${mod},`);
				} else {
					expect(out).not.toContain(mod);
				}
			}
		});
	}

	it('[core] yields an empty OPTIONAL_PLUGINS array with no imports', () => {
		const out = renderPluginsBarrel(set());
		expect(out).toContain('export const OPTIONAL_PLUGINS: ReadonlyArray<PluginModule> = [];');
		// Only the contribution type import; no plugin wiring-module imports.
		for (const id of OPTIONAL_PLUGINS) {
			expect(out).not.toContain(PLUGIN_MANIFEST[id].configModule);
		}
	});
});

describe('composePlugins (end-to-end over a synthetic superset app dir)', () => {
	/** Build a minimal superset app dir mirroring the template's shape: owned
	 *  files per plugin, the two barrels, and a superset package.json. */
	function makeApp(): string {
		const dir = mkdtempSync(join(tmpdir(), 'create-devstack-app-compose-'));
		// Owned files for every optional plugin (panel / lib / wiring / spec).
		for (const id of OPTIONAL_PLUGINS) {
			const spec = PLUGIN_MANIFEST[id];
			for (const f of spec.files) {
				writeFileSync(makeDir(dir, f), `// ${id} owned: ${f}\nexport const x = 1;\n`);
			}
			for (const d of spec.dirs) {
				writeFileSync(makeDir(dir, `${d}/Move.toml`), `[package]\nname = "${id}"\n`);
			}
		}
		// Core panel.
		writeFileSync(makeDir(dir, 'src/panels/CounterPanel.tsx'), 'export const CounterPanel = 1;\n');
		// The two superset barrels (authored = all plugins).
		writeFileSync(makeDir(dir, 'src/app-panels.ts'), renderPanelsBarrel(new Set(ALL_PLUGINS)));
		writeFileSync(
			makeDir(dir, 'src/devstack/plugins.ts'),
			renderPluginsBarrel(new Set(ALL_PLUGINS)),
		);
		// A core file that imports the barrels (must never dangle).
		writeFileSync(
			makeDir(dir, 'src/App.tsx'),
			"import { PANELS } from './app-panels.js';\nexport const App = PANELS;\n",
		);
		// Superset package.json.
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
		const full = join(root, ...rel.split('/'));
		mkdirSync(dirname(full), { recursive: true });
		return full;
	}

	function readPkg(dir: string): { dependencies?: Record<string, string> } {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	}

	function existsAt(dir: string, rel: string): boolean {
		return existsSync(join(dir, ...rel.split('/')));
	}

	// Parametrized over EVERY subset: assert owned files/deps for selected
	// plugins survive, unselected are gone, and there are no dangling refs.
	for (const { label, selected } of SUBSETS) {
		it(`[${label}] composes a clean subset (files, deps, barrels, no dangling refs)`, () => {
			const dir = makeApp();
			try {
				expect(() => composePlugins(dir, selected)).not.toThrow();

				const deps = readPkg(dir).dependencies ?? {};
				expect(deps['@mysten/sui']).toBeDefined(); // core dep untouched

				for (const id of OPTIONAL_PLUGINS) {
					const spec = PLUGIN_MANIFEST[id];
					const kept = selected.has(id);
					for (const f of spec.files) {
						expect(existsAt(dir, f)).toBe(kept);
					}
					for (const d of spec.dirs) {
						expect(existsAt(dir, `${d}/Move.toml`)).toBe(kept);
					}
					for (const dep of spec.deps) {
						expect(deps[dep] === undefined).toBe(!kept);
					}
				}

				// Barrels reference only selected plugins.
				const panelsBarrel = readFileSync(join(dir, 'src/app-panels.ts'), 'utf8');
				const pluginsBarrel = readFileSync(join(dir, 'src/devstack/plugins.ts'), 'utf8');
				for (const id of OPTIONAL_PLUGINS) {
					const present = selected.has(id);
					expect(panelsBarrel.includes(PLUGIN_MANIFEST[id].panel)).toBe(present);
					expect(pluginsBarrel.includes(PLUGIN_MANIFEST[id].configModule)).toBe(present);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it('tolerates a plugin whose owned files are missing (rm -f semantics)', () => {
		const dir = makeApp();
		try {
			// Pre-delete deepbook's files; composing without deepbook must not throw.
			for (const f of PLUGIN_MANIFEST.deepbook.files) {
				rmSync(join(dir, ...f.split('/')), { force: true });
			}
			expect(() => composePlugins(dir, set('walrus', 'seal'))).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('guard catches a dangling reference to a removed module', () => {
		const dir = makeApp();
		try {
			// Inject a core file that imports walrus's lib, then compose WITHOUT
			// walrus — the guard must flag the leftover reference.
			writeFileSync(
				join(dir, 'src', 'App.tsx'),
				"import { storeBlob } from './lib/walrus.js';\nexport const x = storeBlob;\n",
			);
			expect(() => composePlugins(dir, set('seal'))).toThrow(/still references removed module/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a selected set without 'core'", () => {
		const dir = makeApp();
		try {
			expect(() => composePlugins(dir, new Set<PluginId>(['walrus']))).toThrow(/core/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('manifest sanity', () => {
	it('every optional plugin spec names a panel, wiring module, files + deps', () => {
		for (const id of OPTIONAL_PLUGINS) {
			const spec = PLUGIN_MANIFEST[id];
			expect(spec.panel.length).toBeGreaterThan(0);
			expect(spec.configModule.length).toBeGreaterThan(0);
			expect(spec.files.length).toBeGreaterThan(0);
			expect(spec.deps.length).toBeGreaterThan(0);
			// The wiring module must be among the plugin's owned files so it is
			// removed when the plugin is unselected.
			expect(spec.files).toContain(`src/devstack/${spec.configModuleSpecifier}.ts`);
		}
	});
});
