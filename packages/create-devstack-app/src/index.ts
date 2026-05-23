// Programmatic API for the scaffolder. The bin (`src/bin.ts`) is a thin
// argv parser around `scaffold(...)`. Importing this package directly is
// useful for monorepo automation (e.g. a turbo task that creates apps
// from a config file).

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Bundled template directory. The build's `sync-template` script copies
 *  `examples/_template/` here so the published package is self-contained. */
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_DIR = resolve(HERE, '..', 'template');

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

	log(`creating ${appDir} from ${templateDir}…`);
	copyTemplate(templateDir, appDir);
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
		// of `examples/_template/` (the build script normally strips them, but
		// belt-and-braces).
		filter: (s) => {
			const rel = relative(src, s);
			return rel === '' || !shouldSkip(rel);
		},
	});
}

const SKIP = new Set([
	'node_modules',
	'dist',
	'.devstack',
	'.turbo',
	'generated',
	'test-results',
	'playwright-report',
	'playwright',
	'tsconfig.app.tsbuildinfo',
	'tsconfig.node.tsbuildinfo',
]);

function shouldSkip(path: string): boolean {
	const parts = path.split('/');
	for (const p of parts) {
		if (SKIP.has(p)) return true;
		// Generated config siblings (`vite.config.js`, `vite.config.d.ts`)
		// produced by tsc-watch sessions in the source repo.
		if (/^.*\.config\.(js|d\.ts)$/.test(p)) return true;
	}
	return false;
}

function rewriteName(appDir: string, name: string): void {
	for (const file of walk(appDir)) {
		const rel = file.slice(appDir.length + 1);
		if (rel === 'package.json') {
			rewritePackageJson(file, name);
		} else if (rel === 'devstack.config.ts' || rel === 'playwright.config.ts') {
			rewriteDevstackText(file, name);
		}
	}
}

function rewritePackageJson(path: string, name: string): void {
	const raw = readFileSync(path, 'utf8');
	const json = JSON.parse(raw) as {
		name?: string;
		version?: string;
		private?: boolean;
		scripts?: Record<string, string>;
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
	writeFileSync(path, `${JSON.stringify(json, null, '\t')}\n`);
}

function rewriteDevstackText(path: string, name: string): void {
	const raw = readFileSync(path, 'utf8');
	writeFileSync(
		path,
		raw
			.replaceAll('dev.template.localhost', `dev.${name}.localhost`)
			.replaceAll("stackName: '_template'", `stackName: '${name}'`),
	);
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
