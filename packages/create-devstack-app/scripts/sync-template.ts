// Copies `examples/_template/` into `packages/create-devstack-app/template/`
// at build time so the published package is self-contained. Skips generated
// dirs (`node_modules`, `dist`, `.devstack`, `.turbo`, Move build outputs,
// build-tsbuildinfo).
//
// Also rewrites `template/package.json` so the published package can be
// `pnpm install`-ed in a fresh app outside the monorepo:
//   - `workspace:*` → `^<version>` from each workspace package's
//     package.json (so a freshly scaffolded app pins a published version
//     of `@mysten-incubation/devstack`, not a workspace path).
//   - `catalog:` → the version recorded in `pnpm-workspace.yaml` under
//     `catalog:` (so React, dapp-kit, etc. resolve outside the monorepo).
// Without this rewriting, `pnpm create @mysten-incubation/devstack-app
// my-app && cd my-app && pnpm install` fails because pnpm can't resolve
// monorepo-only specifiers.
//
// NOTE: the `workspace:*` rewrite for the `@mysten-incubation/*` SDK deps is
// now a build-time *fallback*. At scaffold time, `src/index.ts` overwrites
// those specs with the scaffolder's OWN resolved (publish-time-rewritten)
// versions — the `@mysten/create-dapp` pattern — so the committed snapshot
// here no longer needs to be the source of truth for SDK versions and won't
// drift. The `catalog:` rewrite is NOT redundant: those deps (React, dapp-kit,
// etc.) are not injected and still need pinning here.
//
// Run via `pnpm -F @mysten-incubation/create-devstack-app run sync-template`,
// or as part of `pnpm build` (the package script chains the two).
//
// The bundled template is now the LITERAL final source: `examples/_template/`
// is a superset (core + fenced optional plugins) that the scaffolder strips
// per the picker. There are no post-copy "cutover fixups" — sync copies,
// resolves deps, writes support files, then VALIDATES (manifest paths exist;
// shared fenced files balanced).
//
// CI: `pnpm -F @mysten-incubation/create-devstack-app run check-template` is
// the drift detector that proves the bundled `template/` matches
// `examples/_template/`. It is wired into `turbo.json` as the `check-template`
// task, a `dependsOn` of `typecheck`, so a stale bundled `template/` fails CI.

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Shared with `src/index.ts` so the copy-skip list never drifts.
import { shouldSkip } from '../src/skip.ts';
import { OPTIONAL_PLUGINS, PLUGIN_MANIFEST } from '../src/plugin-manifest.ts';
import { assertFencesBalanced } from '../src/strip.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SRC = resolve(REPO_ROOT, 'examples', '_template');
const DST = resolve(PKG_ROOT, 'template');
const CHECK = process.argv.includes('--check');

/** Shared text files that carry plugin fences and must stay balanced. */
const FENCED_SHARED_FILES = ['devstack.config.ts', 'src/App.tsx'] as const;

if (!existsSync(SRC)) {
	throw new Error(`sync-template: source ${SRC} not found. The repo layout may have changed.`);
}

if (CHECK) {
	const tmpRoot = mkdtempSync(join(tmpdir(), 'create-devstack-app-template-'));
	const expected = join(tmpRoot, 'template');
	try {
		syncTemplate(expected);
		const diffs = diffTemplateDirs(DST, expected);
		if (diffs.length > 0) {
			for (const diff of diffs) {
				process.stderr.write(`template drift: ${diff}\n`);
			}
			process.exitCode = 1;
		} else {
			process.stdout.write(`template is in sync with ${SRC}\n`);
		}
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
} else {
	syncTemplate(DST);
	process.stdout.write(`synced ${SRC} → ${DST}\n`);
}

interface PkgJson {
	name?: string;
	version?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function syncTemplate(dst: string): void {
	if (existsSync(dst)) {
		rmSync(dst, { recursive: true, force: true });
	}
	mkdirSync(dst, { recursive: true });

	cpSync(SRC, dst, {
		recursive: true,
		// `shouldSkip` expects a template-relative posix path; the absolute
		// path's suffix segments are what matter, so passing the absolute path
		// is fine (it only checks whether ANY segment is skip-listed).
		filter: (s) => !shouldSkip(s),
	});

	resolveTemplateDeps(dst, REPO_ROOT);
	writeTemplateSupportFiles(dst);
	validateTemplate(dst);
}

/** Validate the synced template against the plugin manifest + fence rules.
 *  Runs in both sync and `--check` so drift is caught early:
 *   - every manifest `files`/`dirs` entry exists in the template;
 *   - every shared fenced file has balanced `begin`/`end` fences. */
function validateTemplate(templateDir: string): void {
	const problems: string[] = [];

	for (const id of OPTIONAL_PLUGINS) {
		const entry = PLUGIN_MANIFEST[id];
		for (const f of entry.files) {
			const p = join(templateDir, f);
			if (!existsSync(p) || !statSync(p).isFile()) {
				problems.push(`plugin '${id}' manifest file missing from template: ${f}`);
			}
		}
		for (const d of entry.dirs) {
			const p = join(templateDir, d);
			if (!existsSync(p) || !statSync(p).isDirectory()) {
				problems.push(`plugin '${id}' manifest dir missing from template: ${d}`);
			}
		}
	}

	for (const rel of FENCED_SHARED_FILES) {
		const p = join(templateDir, rel);
		if (!existsSync(p)) {
			problems.push(`fenced shared file missing from template: ${rel}`);
			continue;
		}
		try {
			assertFencesBalanced(readFileSync(p, 'utf8'), rel);
		} catch (e) {
			problems.push((e as Error).message);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`sync-template validation failed:\n  - ${problems.join('\n  - ')}\n` +
				`(Template paths/markers must match packages/create-devstack-app/src/plugin-manifest.ts. ` +
				`If the deepbook track hasn't landed yet, its manifest files are expected to be present in ` +
				`examples/_template/ once that track ships.)`,
		);
	}
}

function diffTemplateDirs(actual: string, expected: string): ReadonlyArray<string> {
	if (!existsSync(actual)) {
		return [`missing bundled template directory ${actual}`];
	}
	const actualFiles = collectFiles(actual);
	const expectedFiles = collectFiles(expected);
	const actualSet = new Set(actualFiles);
	const expectedSet = new Set(expectedFiles);
	const diffs: string[] = [];

	for (const file of expectedFiles) {
		if (!actualSet.has(file)) {
			diffs.push(`missing file ${file}`);
		}
	}
	for (const file of actualFiles) {
		if (!expectedSet.has(file)) {
			diffs.push(`extra file ${file}`);
		}
	}
	for (const file of expectedFiles) {
		if (!actualSet.has(file)) continue;
		const actualBytes = readFileSync(join(actual, file));
		const expectedBytes = readFileSync(join(expected, file));
		if (!actualBytes.equals(expectedBytes)) {
			diffs.push(`changed file ${file}`);
		}
	}

	return diffs.sort();
}

function collectFiles(root: string): ReadonlyArray<string> {
	const files: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, rel);
			} else if (entry.isFile()) {
				files.push(rel);
			}
		}
	};
	walk(root, '');
	return files.sort();
}

/** Rewrite `workspace:*` and `catalog:` specifiers in `template/package.json`
 * to concrete published versions, so the bundled template is installable
 * in a freshly scaffolded app outside the monorepo. */
function resolveTemplateDeps(templateDir: string, repoRoot: string): void {
	const pkgPath = join(templateDir, 'package.json');
	const raw = readFileSync(pkgPath, 'utf8');
	const json = JSON.parse(raw) as PkgJson;

	const workspaceVersions = collectWorkspaceVersions(repoRoot);
	const catalog = readCatalog(repoRoot);

	for (const field of ['dependencies', 'devDependencies'] as const) {
		const deps = json[field];
		if (deps === undefined) continue;
		for (const [name, spec] of Object.entries(deps)) {
			if (spec === 'workspace:*' || spec.startsWith('workspace:')) {
				const v = workspaceVersions.get(name);
				if (v === undefined) {
					throw new Error(
						`sync-template: workspace package '${name}' is referenced as ${spec} ` +
							`in template/package.json but not found under packages/. Did the package ` +
							`get renamed or removed?`,
					);
				}
				deps[name] = `^${v}`;
			} else if (spec === 'catalog:' || spec.startsWith('catalog:')) {
				const v = catalog.get(name);
				if (v === undefined) {
					throw new Error(
						`sync-template: dependency '${name}' is ${spec} but missing from the ` +
							`pnpm-workspace.yaml \`catalog:\` block. Add it before running sync-template.`,
					);
				}
				deps[name] = v;
			}
		}
	}

	rewriteTemplateScripts(json);
	writeFileSync(pkgPath, `${JSON.stringify(json, null, '\t')}\n`);
}

function rewriteTemplateScripts(json: PkgJson): void {
	const scripts = json.scripts;
	if (scripts === undefined) {
		throw new Error('sync-template: template/package.json is missing a scripts block.');
	}

	const scaffoldedScripts: Record<string, string> = {
		'devstack:apply': 'DEVSTACK_APP=_template devstack apply',
		apply: 'pnpm run devstack:apply',
		dev: 'DEVSTACK_APP=_template devstack up',
		build:
			'pnpm run devstack:apply && DEVSTACK_APP=_template tsc -b && DEVSTACK_APP=_template vite build',
		preview: scripts.preview ?? 'vite preview',
		typecheck: 'pnpm run devstack:apply && tsc -b --noEmit',
		// `vitest run` runs the counter.test.ts unit suite (non-empty); the
		// `_template` DEVSTACK_APP token is rewritten to the app name at scaffold.
		test: scripts.test ?? 'pnpm run typecheck && vitest run',
		// e2e runs against the dedicated `test` stack: its `pnpm dev` webServer
		// brings the stack up (no manual apply), distinct from the primary stack.
		'test:e2e': 'DEVSTACK_APP=_template DEVSTACK_STACK=test playwright test',
		clean: scripts.clean ?? 'rm -rf dist .turbo node_modules/.tmp',
	};

	json.scripts = scaffoldedScripts;
}

function collectWorkspaceVersions(repoRoot: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const dir of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const pkgJsonPath = join(repoRoot, 'packages', dir.name, 'package.json');
		if (!existsSync(pkgJsonPath)) continue;
		const json = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PkgJson;
		if (json.name === undefined || json.version === undefined) continue;
		out.set(json.name, json.version);
	}
	return out;
}

/** Minimal `catalog:` parser. The pnpm-workspace.yaml `catalog:` block is a
 * flat name → version map; we don't pull in a YAML dep just for this. */
function readCatalog(repoRoot: string): Map<string, string> {
	const path = join(repoRoot, 'pnpm-workspace.yaml');
	const text = readFileSync(path, 'utf8');
	const out = new Map<string, string>();
	const lines = text.split('\n');
	let inCatalog = false;
	for (const line of lines) {
		if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
		if (/^catalog:\s*$/.test(line)) {
			inCatalog = true;
			continue;
		}
		// Top-level key with no indent ends the catalog block.
		if (inCatalog && /^[a-zA-Z_-]+:/.test(line)) {
			inCatalog = false;
			continue;
		}
		if (!inCatalog) continue;
		const m = line.match(/^\s+(['"]?)([^'"\s]+)\1:\s*(.+?)\s*(?:#.*)?$/);
		if (m === null) continue;
		const name = m[2];
		const value = m[3];
		if (name === undefined || value === undefined) continue;
		out.set(name, stripQuotes(value));
	}
	return out;
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

function writeTemplateSupportFiles(templateDir: string): void {
	// npm treats `.gitignore` specially while packing. Ship it under a neutral
	// name and let the scaffolder restore it after copying the template.
	writeFileSync(
		join(templateDir, '_gitignore'),
		`# Dependencies
node_modules/

# Build output
dist/
coverage/
.turbo/
*.tsbuildinfo
*.log

# Local environment
.env
.env.local
.env.*.local
*.local

# Devstack runtime and generated app bindings
.devstack/
src/generated/

# Move build artifacts
move/**/build/
move/**/package_summaries/
*.mv

# Playwright
test-results/
playwright-report/
playwright/.cache/

# Editor / OS
.DS_Store
.idea/
.vscode/
`,
	);

	writeFileSync(
		join(templateDir, 'README.md'),
		`# Devstack App

A minimal Sui app scaffolded with \`@mysten-incubation/create-devstack-app\`.

## Commands

\`\`\`bash
pnpm dev       # start the devstack supervisor and Vite app
pnpm build     # apply the stack, typecheck, and build the app
pnpm test      # typecheck and run unit tests
pnpm test:e2e  # bring up the test stack and run the Playwright specs
\`\`\`

## Project Shape

- \`devstack.config.ts\` defines the local Sui stack, accounts, Move package(s), and dev wallet.
- \`move/counter/\` contains the core example Move package.
- \`src/dapp-kit.ts\` wires dApp Kit to the generated devstack config.
- \`src/App.tsx\` registers the demo panels (counter, plus any plugins you chose at scaffold).

\`devstack apply\` writes runtime state under \`.devstack/\` and generated app bindings under
\`src/generated/\`; both are ignored because they are regenerated for each checkout.
`,
	);
}
