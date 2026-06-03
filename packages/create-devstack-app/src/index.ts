// Programmatic API for the scaffolder. The bin (`src/bin.ts`) is a thin
// argv parser around `scaffold(...)`. Importing this package directly is
// useful for monorepo automation (e.g. a turbo task that creates apps
// from a config file).

import { spawn } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composePlugins } from './compose.js';
import { ALL_PLUGINS, type PluginId } from './plugin-manifest.js';
import { SKIP, shouldSkip } from './skip.js';

export interface ScaffoldOptions {
	/** App name. Used as the directory name, package name, `DEVSTACK_APP`,
	 *  and generated local router hostnames. Must match
	 *  `/^[a-z][a-z0-9-]*$/` - lowercase, dash-separated, starts with a
	 *  letter, no underscores (the `_template` underscore is reserved for
	 *  the bundled template placeholder; user apps don't use it). */
	name: string;
	/** Where to create the app directory. Defaults to `process.cwd()`.
	 *  The final path is `<targetDir>/<name>/`. */
	targetDir?: string;
	/** Skip `pnpm install` after copy. Default false. */
	skipInstall?: boolean;
	/** Skip `git init` + initial commit. Default false. */
	skipGit?: boolean;
	/** Override the template source directory (testing hook). Defaults to
	 *  the bundled `template/` next to this module. */
	templateDir?: string;
	/** Which plugins to keep. `core` is always implied. Unlisted optional
	 *  plugins are removed (their files deleted, the generated barrels
	 *  regenerated from the selected set, their deps dropped). Defaults to ALL
	 *  plugins. Kept prompt-free so `scaffold` stays pure/testable — the
	 *  interactive picker lives in `bin.ts`. */
	plugins?: ReadonlyArray<PluginId>;
	/** Where to log progress. Defaults to `console.log`. */
	log?: (msg: string) => void;
}

export interface ScaffoldResult {
	/** Absolute path of the new app directory. */
	appDir: string;
	/** Whether `pnpm install` actually ran (vs skipped). */
	installed: boolean;
	/** Whether `git init` actually ran (vs skipped). */
	gitInitialized: boolean;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Bundled, authored template directory. Shipped in the published package's
 *  `files` so the package is self-contained. */
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_DIR = resolve(HERE, '..', 'template');

/** Workspace SDK packages whose versions are injected into the scaffolded
 *  app at scaffold time. These appear in this package's OWN `devDependencies`
 *  as `workspace:^`; pnpm rewrites them to the matching published version at
 *  publish, so `create @latest` always pins matching-latest SDK versions —
 *  mirroring `@mysten/create-dapp`. The committed template `package.json`
 *  carries only placeholders that are always overwritten here. */
const INJECTED_SDK_PACKAGES = [
	'@mysten-incubation/devstack',
	'@mysten-incubation/dev-wallet',
] as const;

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
	if (!NAME_RE.test(opts.name)) {
		throw new Error(
			`create-devstack-app: invalid app name '${opts.name}'. Must match ${NAME_RE.source} (lowercase, dash-separated, starts with a letter; no underscores).`,
		);
	}
	const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
	const targetDir = resolve(opts.targetDir ?? process.cwd());
	const appDir = join(targetDir, opts.name);
	if (existsSync(appDir)) {
		throw new Error(`create-devstack-app: ${appDir} already exists. Pick a different name.`);
	}

	const templateDir = opts.templateDir ?? DEFAULT_TEMPLATE_DIR;
	if (!existsSync(templateDir)) {
		throw new Error(
			`create-devstack-app: template directory ${templateDir} not found. The package may be installed without its bundled template — try reinstalling.`,
		);
	}

	// Resolve the selected plugin set: default = all; `core` always included.
	const selected = new Set<PluginId>(opts.plugins ?? ALL_PLUGINS);
	selected.add('core');

	log(`creating ${appDir} from ${templateDir}…`);
	copyTemplate(templateDir, appDir);
	const omitted = ALL_PLUGINS.filter((p) => p !== 'core' && !selected.has(p));
	if (omitted.length > 0) {
		log(`composing without plugins: ${omitted.join(', ')}…`);
	}
	composePlugins(appDir, selected);
	rewriteName(appDir, opts.name);

	let installed = false;
	if (opts.skipInstall !== true) {
		log('running pnpm install…');
		await run('pnpm', ['install'], appDir);
		installed = true;
	}

	let gitInitialized = false;
	if (opts.skipGit !== true) {
		try {
			log('initializing git…');
			await run('git', ['init', '--quiet'], appDir);
			await run('git', ['add', '.'], appDir);
			await run(
				'git',
				[
					'commit',
					'--quiet',
					'-m',
					`Scaffold ${opts.name} from @mysten-incubation/devstack template`,
				],
				appDir,
			);
			gitInitialized = true;
		} catch (e) {
			log(`git init skipped (${(e as Error).message}). Run \`git init && git add .\` manually.`);
		}
	}

	log('');
	log(`✓ ${opts.name} ready at ${appDir}`);
	log('');
	log('next steps:');
	log(`  cd ${opts.name}`);
	if (!installed) log('  pnpm install');
	log('  pnpm dev          # bring up localnet, publish hello, start vite');
	log('  pnpm test:e2e     # start the stack and run the Playwright spec');
	log('');

	return { appDir, installed, gitInitialized };
}

function copyTemplate(src: string, dst: string): void {
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, {
		recursive: true,
		// Skip generated/build artifacts that may be present in a dev checkout
		// of the authored `template/` (e.g. after running `devstack apply`
		// locally to author it).
		filter: (s) => {
			const rel = relative(src, s);
			return rel === '' || !shouldSkip(rel);
		},
	});

	const packedGitignore = join(dst, '_gitignore');
	if (existsSync(packedGitignore)) {
		renameSync(packedGitignore, join(dst, '.gitignore'));
	}
}

function rewriteName(appDir: string, name: string): void {
	const sdkVersions = getInjectedSdkVersions();
	for (const file of walk(appDir)) {
		const rel = file.slice(appDir.length + 1);
		if (rel === 'package.json') {
			rewritePackageJson(file, name, sdkVersions);
		} else if (rel === 'devstack.config.ts' || rel === 'playwright.config.ts') {
			rewriteDevstackText(file, name);
		} else if (rel === 'tsconfig.app.json' || rel === 'tsconfig.json') {
			rewriteTsconfigPaths(file, name);
		}
	}
}

/** Read this package's OWN `package.json` (resolved from the bundled module
 *  location, the same `HERE`/`..` anchor the template dir uses) and return the
 *  resolved version spec for each injected SDK package. At publish, pnpm has
 *  rewritten these `workspace:^` specs to the matching published version, so
 *  the scaffolder injects matching-latest versions in lockstep with its own
 *  release. In a dev checkout the specs are still `workspace:*`/`workspace:^`,
 *  which the bundled template's resolved fallback covers. */
function getInjectedSdkVersions(): Map<string, string> {
	const ownPkgPath = resolve(HERE, '..', 'package.json');
	const json = JSON.parse(readFileSync(ownPkgPath, 'utf8')) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const specs = { ...json.dependencies, ...json.devDependencies };
	const out = new Map<string, string>();
	for (const pkg of INJECTED_SDK_PACKAGES) {
		const spec = specs[pkg];
		// Skip unresolved workspace specs (dev checkout): the bundled template's
		// sync-time fallback already pins a concrete version.
		if (spec !== undefined && !spec.startsWith('workspace:')) {
			out.set(pkg, spec);
		}
	}
	return out;
}

function rewritePackageJson(path: string, name: string, sdkVersions: Map<string, string>): void {
	const raw = readFileSync(path, 'utf8');
	const json = JSON.parse(raw) as {
		name?: string;
		version?: string;
		private?: boolean;
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	json.name = name;
	json.private = true;
	if (json.version === undefined) json.version = '0.0.0';
	if (json.scripts !== undefined) {
		for (const [script, command] of Object.entries(json.scripts)) {
			json.scripts[script] = command
				.replaceAll('DEVSTACK_APP=_template', `DEVSTACK_APP=${name}`)
				.replaceAll('DEVSTACK_APP=template', `DEVSTACK_APP=${name}`);
		}
	}
	// Overwrite the template's placeholder SDK specs with the scaffolder's own
	// resolved (publish-time-rewritten) versions, so a scaffolded app always
	// pins matching-latest — mirroring `@mysten/create-dapp`.
	for (const field of ['dependencies', 'devDependencies'] as const) {
		const deps = json[field];
		if (deps === undefined) continue;
		for (const [pkg, version] of sdkVersions) {
			if (deps[pkg] !== undefined) {
				deps[pkg] = version;
			}
		}
	}
	writeFileSync(path, `${JSON.stringify(json, null, '\t')}\n`);
}

function rewriteDevstackText(path: string, name: string): void {
	const raw = readFileSync(path, 'utf8');
	writeFileSync(
		path,
		raw
			// Router hostnames. The test stack uses `dev.test.<app>.localhost`,
			// the primary/default stack `dev.<app>.localhost`. Order matters:
			// rewrite the more-specific `dev.test.` token first so the second
			// replace doesn't partially clobber it.
			.replaceAll('dev.test._template.localhost', `dev.test.${name}.localhost`)
			.replaceAll('dev.test.template.localhost', `dev.test.${name}.localhost`)
			.replaceAll('dev._template.localhost', `dev.${name}.localhost`)
			.replaceAll('dev.template.localhost', `dev.${name}.localhost`)
			// DEVSTACK_APP token inside playwright `command`/`env`.
			.replaceAll('DEVSTACK_APP=_template', `DEVSTACK_APP=${name}`)
			.replaceAll('DEVSTACK_APP=template', `DEVSTACK_APP=${name}`)
			// Stack name.
			.replaceAll("stackName: '_template'", `stackName: '${name}'`)
			.replaceAll("stackName: 'template'", `stackName: '${name}'`),
	);
}

/** Rewrite the `@devstack-dev/*` path segment `stacks/_template` →
 *  `stacks/<name>` in the app/json tsconfig (the dev-only generated-extras
 *  alias resolves to `./.devstack/stacks/<name>/generated-extras/*`). */
function rewriteTsconfigPaths(path: string, name: string): void {
	const raw = readFileSync(path, 'utf8');
	const next = raw
		.replaceAll('stacks/_template/', `stacks/${name}/`)
		.replaceAll('stacks/template/', `stacks/${name}/`);
	if (next !== raw) writeFileSync(path, next);
}

function* walk(dir: string): IterableIterator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP.has(entry.name)) continue;
			yield* walk(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolveP, rejectP) => {
		const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
		child.on('error', rejectP);
		child.on('exit', (code) => {
			if (code === 0) resolveP();
			else rejectP(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
		});
	});
}
