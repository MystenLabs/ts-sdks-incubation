// Per-plugin manifest for the scaffolder's interactive picker + strip
// mechanism. The template (`examples/_template/`) is a *superset*: it carries
// every optional plugin's files, dirs, and deps. At scaffold time the picker
// strips the plugins the user didn't select.
//
// Two removal mechanisms:
//   1. Plugin-OWNED files/dirs (panels, libs, specs, move packages) listed in
//      `files`/`dirs` are deleted wholesale for unselected plugins.
//   2. SHARED files (devstack.config.ts, src/App.tsx, e2e specs that reference
//      multiple plugins) carry `// devstack:begin <plugin>` / `// devstack:end
//      <plugin>` comment fences; the stripper drops unselected blocks and
//      removes only the fence lines for selected blocks. Shared files are NOT
//      listed in any plugin's `files` (they're always kept + fence-stripped).
//   3. Optional `deps`/`devDeps` are removed structurally from package.json
//      (JSON has no comments, so no fences there).
//
// Paths are template-relative (posix). Strip semantics are `rm -f`: missing
// files/dirs are tolerated, so a plugin whose template content doesn't exist
// yet (e.g. deepbook before its track lands) still strips cleanly.

/** The four plugin ids. `core` is always present and never stripped. */
export type PluginId = 'core' | 'walrus' | 'seal' | 'deepbook';

/** All plugin ids, including non-strippable `core`. */
export const ALL_PLUGINS: ReadonlyArray<PluginId> = ['core', 'walrus', 'seal', 'deepbook'];

/** Optional plugin ids (everything the picker can strip). */
export const OPTIONAL_PLUGINS: ReadonlyArray<Exclude<PluginId, 'core'>> = [
	'walrus',
	'seal',
	'deepbook',
];

export interface PluginManifestEntry {
	/** Plugin-owned files (template-relative posix paths). Removed wholesale
	 *  when the plugin is unselected. `rm -f` semantics — missing is fine. */
	readonly files: ReadonlyArray<string>;
	/** Plugin-owned directories (e.g. a local Move package). Removed
	 *  recursively when unselected. `rm -rf` semantics — missing is fine. */
	readonly dirs: ReadonlyArray<string>;
	/** `dependencies` keys to delete from package.json when unselected. */
	readonly deps: ReadonlyArray<string>;
	/** `devDependencies` keys to delete from package.json when unselected. */
	readonly devDeps?: ReadonlyArray<string>;
}

/** Per-optional-plugin manifest. `core` is intentionally absent: it owns no
 *  strippable files and is never removed. Shared fenced files
 *  (devstack.config.ts, src/App.tsx) are NOT listed here. */
export const PLUGIN_MANIFEST: Readonly<
	Record<Exclude<PluginId, 'core'>, PluginManifestEntry>
> = {
	walrus: {
		files: ['src/panels/WalrusPanel.tsx', 'src/lib/walrus.ts', 'e2e/walrus.spec.ts'],
		dirs: [],
		deps: ['@mysten/walrus', '@mysten/walrus-wasm'],
	},
	seal: {
		files: ['src/panels/SealPanel.tsx', 'src/lib/seal.ts', 'e2e/seal.spec.ts'],
		dirs: ['move/vault'],
		deps: ['@mysten/seal'],
	},
	deepbook: {
		// NOTE: deepbook template content may not exist yet (the deepbook track
		// adds it after plugin investigation). Strip tolerates missing paths.
		files: ['src/panels/DeepbookPanel.tsx', 'src/lib/deepbook.ts', 'e2e/deepbook.spec.ts'],
		dirs: [],
		deps: ['@mysten/deepbook-v3'],
	},
};
