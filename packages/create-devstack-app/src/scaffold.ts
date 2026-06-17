// Scaffolding engine: copy `templates/<template>/` verbatim, render the ONE
// generated file (`devstack.config.ts`), patch package.json, then run
// install + git init. Kept prompt-free so it stays pure/testable — the
// interactive flow lives in `bin.ts`.

import { spawn, spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDevstackConfig, type TemplateId } from './render-config.js';
import { SERVICE_IDS, SERVICES, type ServiceId } from './services.js';

export interface ScaffoldOptions {
	/** App name. Used as the directory name and package name. Must match
	 *  `/^[a-z][a-z0-9-]*$/` — lowercase, dash-separated, starts with a
	 *  letter. */
	name: string;
	/** Where to create the app directory. Defaults to `process.cwd()`.
	 *  The final path is `<targetDir>/<name>/`. */
	targetDir?: string;
	/** Which template to scaffold: `app` (React dapp) or `ts` (no frontend). */
	template: TemplateId;
	/** Selected optional services. The sui localnet is always included. */
	services: ReadonlyArray<ServiceId>;
	/** Skip `pnpm install` after copy. Default false. */
	skipInstall?: boolean;
	/** Skip the best-effort post-install `pnpm codegen` step. Codegen is also
	 *  implicitly skipped when install is skipped (no devstack binary) or when
	 *  no host `sui` CLI is found. Default false. */
	skipCodegen?: boolean;
	/** Skip `git init` + initial commit. Default false. */
	skipGit?: boolean;
	/** Where to log progress. Defaults to stdout. */
	log?: (msg: string) => void;
}

export interface ScaffoldResult {
	/** Absolute path of the new app directory. */
	appDir: string;
	/** Whether `pnpm install` actually ran (vs skipped). */
	installed: boolean;
	/** Whether the post-install `pnpm codegen` step actually ran to completion.
	 *  False when skipped (no install, --no-codegen, or no host `sui` CLI) or
	 *  when it failed (non-fatal). The next-steps text uses this to decide
	 *  whether to tell the user to run `pnpm codegen`. */
	codegenRan: boolean;
	/** Whether `git init` actually ran (vs skipped). */
	gitInitialized: boolean;
	/** Whether the docker daemon answered the preflight probe. Only affects
	 *  the next-steps text — never fatal. */
	dockerOk: boolean;
}

export const NAME_RE = /^[a-z][a-z0-9-]*$/;

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(HERE, '..', 'templates');

/** Workspace SDK packages whose versions are injected into the scaffolded
 *  app. They appear in this package's OWN `devDependencies` as `workspace:^`;
 *  pnpm rewrites that to the matching published version at publish, so
 *  `create @latest` always pins matching-latest SDK versions. */
const INJECTED_SDK_PACKAGES = [
	'@mysten-incubation/devstack',
	'@mysten-incubation/dev-wallet',
] as const;

// Insurance against build/runtime artifacts in a dev checkout of the
// authored templates — these must never be copied into a scaffolded app.
const SKIP_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.devstack', '.turbo']);

/** True if a template-relative posix path must not be copied.
 *
 *  `src/generated` is COPIED, not skipped: the templates ship the committed
 *  codegen projection tree (id-free bindings + sentinel-id config + the
 *  emitted `src/generated/.gitignore` that tracks it), exactly like the
 *  examples. This lets a freshly-scaffolded app `tsc`/`vite build` on a
 *  clean checkout with no stack running — `devstack up`/`apply` no longer
 *  write `src/generated` (codegen output moved to the gitignored `.devstack/`),
 *  so the bindings MUST travel with the template. `move/**\/build` and
 *  `package_summaries` are still skipped as genuine build artifacts. */
export function shouldSkipTemplatePath(rel: string): boolean {
	for (const segment of rel.split('/')) {
		if (SKIP_SEGMENTS.has(segment)) return true;
		if (segment.endsWith('.tsbuildinfo')) return true;
	}
	return false;
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
	if (!NAME_RE.test(opts.name)) {
		throw new Error(
			`create-devstack-app: invalid app name '${opts.name}'. Must match ${NAME_RE.source} (lowercase, dash-separated, starts with a letter).`,
		);
	}
	const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
	const targetDir = resolve(opts.targetDir ?? process.cwd());
	const appDir = join(targetDir, opts.name);
	if (existsSync(appDir) && (!statSync(appDir).isDirectory() || readdirSync(appDir).length > 0)) {
		throw new Error(`create-devstack-app: ${appDir} already exists and is not empty.`);
	}

	const templateDir = join(TEMPLATES_DIR, opts.template);
	if (!existsSync(templateDir)) {
		throw new Error(
			`create-devstack-app: template directory ${templateDir} not found. The package may be installed without its bundled templates — try reinstalling.`,
		);
	}

	const services = SERVICE_IDS.filter((id) => opts.services.includes(id));
	const dockerOk = dockerPreflight();

	log(`creating ${appDir} from the '${opts.template}' template…`);
	copyTemplate(templateDir, appDir);
	writeFileSync(
		join(appDir, 'devstack.config.ts'),
		renderDevstackConfig(opts.template, new Set(services)),
	);
	patchPackageJson(appDir, opts.name, services);

	let installed = false;
	if (opts.skipInstall !== true) {
		log('running pnpm install…');
		await run('pnpm', ['install'], appDir);
		installed = true;
	}

	// Best-effort codegen so plugins selected at creation time (deepbook, pyth,
	// walrus, seal) get their config.ts id-resolver entries + local bindings
	// without the user manually running `pnpm codegen`. Requires install (no
	// devstack binary otherwise) and a host `sui` CLI — `devstack codegen` now
	// fails fast without one. Always non-fatal: never aborts the scaffold, and
	// runs before git init so generated files land in the initial commit.
	let codegenRan = false;
	if (installed && opts.skipCodegen !== true) {
		if (hasHostSui()) {
			try {
				log('running pnpm codegen…');
				await run('pnpm', ['codegen'], appDir);
				codegenRan = true;
			} catch (e) {
				log(
					`codegen failed (${(e as Error).message}). Run \`pnpm codegen\` once your Move sources build, or just \`pnpm dev\`.`,
				);
			}
		} else {
			log('codegen skipped — no `sui` CLI on PATH. Install sui, then run `pnpm codegen`.');
		}
	}

	let gitInitialized = false;
	if (opts.skipGit !== true) {
		try {
			log('initializing git…');
			await run('git', ['init', '--quiet'], appDir);
			await run('git', ['add', '.'], appDir);
			await run(
				'git',
				['commit', '--quiet', '-m', `Scaffold ${opts.name} with create-devstack-app`],
				appDir,
			);
			gitInitialized = true;
		} catch (e) {
			log(`git init skipped (${(e as Error).message}). Run \`git init && git add .\` manually.`);
		}
	}

	return { appDir, installed, codegenRan, gitInitialized, dockerOk };
}

function copyTemplate(src: string, dst: string): void {
	cpSync(src, dst, {
		recursive: true,
		filter: (s) => {
			const rel = relative(src, s).split(sep).join('/');
			return rel === '' || !shouldSkipTemplatePath(rel);
		},
	});
	const packedGitignore = join(dst, '_gitignore');
	if (existsSync(packedGitignore)) {
		renameSync(packedGitignore, join(dst, '.gitignore'));
	}
}

/** Resolve the version spec to inject for each SDK package from this
 *  package's OWN manifest. At publish, pnpm has rewritten the `workspace:^`
 *  devDependency specs to the matching published versions. In a dev checkout
 *  they are still `workspace:*`/`workspace:^` — warn and keep the template's
 *  pinned fallback versions. Exported for tests. */
export function resolveSdkVersions(
	ownPkg: {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	},
	warn: (msg: string) => void = (m) => console.warn(m),
): Map<string, string> {
	const specs = { ...ownPkg.dependencies, ...ownPkg.devDependencies };
	const versions = new Map<string, string>();
	const unresolved: string[] = [];
	for (const pkg of INJECTED_SDK_PACKAGES) {
		const spec = specs[pkg];
		if (spec === undefined) continue;
		if (spec.startsWith('workspace:')) {
			unresolved.push(pkg);
			continue;
		}
		versions.set(pkg, spec);
	}
	if (unresolved.length > 0) {
		warn(
			`create-devstack-app: ${unresolved.join(', ')} still resolve to workspace specs (dev checkout) — keeping the template's pinned versions.`,
		);
	}
	return versions;
}

function patchPackageJson(appDir: string, name: string, services: ReadonlyArray<ServiceId>): void {
	const path = join(appDir, 'package.json');
	const json = JSON.parse(readFileSync(path, 'utf8')) as {
		name?: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	json.name = name;

	// Delete unselected services' deps. The templates carry every service's
	// deps so the authored tree typechecks; selection only ever removes.
	for (const id of SERVICE_IDS) {
		if (services.includes(id)) continue;
		for (const dep of SERVICES[id].deps) {
			if (json.dependencies !== undefined) delete json.dependencies[dep];
			if (json.devDependencies !== undefined) delete json.devDependencies[dep];
		}
	}

	// Inject published SDK versions — only for deps the template carries
	// (the ts template has no dev-wallet dep, for example).
	const ownPkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8')) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	for (const [pkg, version] of resolveSdkVersions(ownPkg)) {
		for (const field of ['dependencies', 'devDependencies'] as const) {
			const deps = json[field];
			if (deps?.[pkg] !== undefined) deps[pkg] = version;
		}
	}

	writeFileSync(path, `${JSON.stringify(json, null, '\t')}\n`);
}

/** Fast, non-fatal docker daemon probe. Result only affects the printed
 *  next steps ("start Docker Desktop before pnpm dev"). */
function dockerPreflight(): boolean {
	try {
		const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
			timeout: 3_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8',
		});
		return probe.status === 0 && (probe.stdout ?? '').trim().length > 0;
	} catch {
		return false;
	}
}

/** Fast, non-fatal probe for a host `sui` CLI on PATH. `devstack codegen`
 *  requires one (no Docker fallback) and fails fast without it, so we skip the
 *  post-install codegen step rather than have it error. */
function hasHostSui(): boolean {
	try {
		const probe = spawnSync('sui', ['--version'], {
			timeout: 3_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			encoding: 'utf8',
		});
		return probe.status === 0;
	} catch {
		return false;
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
