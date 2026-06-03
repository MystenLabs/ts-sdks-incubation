// Per-plugin spec for the scaffolder's picker + COMPOSE mechanism.
//
// The authored template (`template/`) is a *superset*: it carries every
// optional plugin's files plus two GENERATED barrels that, in the authored
// tree, list every plugin (so the default scaffold == all plugins, and the
// authored template typechecks as-is). At scaffold time the composer:
//
//   1. Deletes each UNSELECTED plugin's owned files/dirs (panels, libs, specs,
//      Move packages, and the `src/devstack/<id>.ts` wiring module).
//   2. REGENERATES the two barrels (`src/app-panels.ts`,
//      `src/devstack/plugins.ts`) from the SELECTED plugins only — plain
//      whole-file writes, no text splicing of authored source.
//   3. Deletes each unselected plugin's `deps`/`devDeps` from package.json.
//
// There are no comment fences and no line parser: selection is expressed by
// *which* modules the two generated barrels reference. Adding a plugin = add a
// `template/src/devstack/<id>.ts` + `template/src/panels/<Panel>.tsx` (+ lib /
// spec / move), then add one entry here. See README for the full checklist.
//
// Paths are template-relative (posix). Deletion is `rm -rf`-style: missing
// files/dirs are tolerated, so a plugin whose template content doesn't exist
// yet still composes cleanly.

/** The four plugin ids. `core` is always present and never removed. */
export type PluginId = 'core' | 'walrus' | 'seal' | 'deepbook';

/** All plugin ids, including non-optional `core`. */
export const ALL_PLUGINS: ReadonlyArray<PluginId> = ['core', 'walrus', 'seal', 'deepbook'];

/** Optional plugin ids, in the canonical barrel order. */
export const OPTIONAL_PLUGINS: ReadonlyArray<Exclude<PluginId, 'core'>> = [
	'walrus',
	'seal',
	'deepbook',
];

export interface PluginSpec {
	/** The exported panel component (in `template/src/panels/<panel>.tsx`).
	 *  Used to regenerate `src/app-panels.ts`. */
	readonly panel: string;
	/** Path of the panel module, template-relative (posix), no extension —
	 *  e.g. `panels/WalrusPanel`. The `app-panels.ts` import specifier. */
	readonly panelModule: string;
	/** The exported wiring module symbol (in `template/src/devstack/<id>.ts`).
	 *  Used to regenerate `src/devstack/plugins.ts`. */
	readonly configModule: string;
	/** Path of the wiring module, template-relative to `src/devstack/`, no
	 *  extension — e.g. `walrus`. The `plugins.ts` import specifier. */
	readonly configModuleSpecifier: string;
	/** Plugin-owned files removed wholesale when the plugin is unselected. */
	readonly files: ReadonlyArray<string>;
	/** Plugin-owned directories (e.g. a local Move package) removed
	 *  recursively when unselected. */
	readonly dirs: ReadonlyArray<string>;
	/** `dependencies` keys to delete from package.json when unselected. */
	readonly deps: ReadonlyArray<string>;
	/** `devDependencies` keys to delete from package.json when unselected. */
	readonly devDeps?: ReadonlyArray<string>;
}

/** Per-optional-plugin spec. `core` is intentionally absent: it owns no
 *  optional files and is never removed. */
export const PLUGIN_MANIFEST: Readonly<Record<Exclude<PluginId, 'core'>, PluginSpec>> = {
	walrus: {
		panel: 'WalrusPanel',
		panelModule: 'panels/WalrusPanel',
		configModule: 'walrusModule',
		configModuleSpecifier: 'walrus',
		files: [
			'src/panels/WalrusPanel.tsx',
			'src/lib/walrus.ts',
			'src/devstack/walrus.ts',
			'e2e/walrus.spec.ts',
		],
		dirs: [],
		deps: ['@mysten/walrus', '@mysten/walrus-wasm'],
	},
	seal: {
		panel: 'SealPanel',
		panelModule: 'panels/SealPanel',
		configModule: 'sealModule',
		configModuleSpecifier: 'seal',
		files: [
			'src/panels/SealPanel.tsx',
			'src/lib/seal.ts',
			'src/devstack/seal.ts',
			'e2e/seal.spec.ts',
		],
		dirs: ['move/vault'],
		deps: ['@mysten/seal'],
	},
	deepbook: {
		panel: 'DeepbookPanel',
		panelModule: 'panels/DeepbookPanel',
		configModule: 'deepbookModule',
		configModuleSpecifier: 'deepbook',
		files: [
			'src/panels/DeepbookPanel.tsx',
			'src/lib/deepbook.ts',
			'src/devstack/deepbook.ts',
			'e2e/deepbook.spec.ts',
		],
		dirs: [],
		deps: ['@mysten/deepbook-v3'],
	},
};
