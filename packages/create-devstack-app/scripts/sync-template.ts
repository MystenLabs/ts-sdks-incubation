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
// Run via `pnpm -F @mysten-incubation/create-devstack-app run sync-template`,
// or as part of `pnpm build` (the package script chains the two).

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SRC = resolve(REPO_ROOT, 'examples', '_template');
const DST = resolve(PKG_ROOT, 'template');
const CHECK = process.argv.includes('--check');
const SKIP = new Set([
	'node_modules',
	'build',
	'dist',
	'.devstack',
	'.turbo',
	'generated',
	'package_summaries',
	'test-results',
	'playwright-report',
	'playwright',
	'tsconfig.app.tsbuildinfo',
	'tsconfig.node.tsbuildinfo',
]);

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
		filter: (s) => {
			const parts = s.split('/');
			for (const p of parts) {
				if (SKIP.has(p)) return false;
				if (/^.*\.config\.(js|d\.ts)$/.test(p)) return false;
			}
			return true;
		},
	});

	resolveTemplateDeps(dst, REPO_ROOT);
	applyTemplateCutoverFixups(dst);
	writeTemplateSupportFiles(dst);
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
		'devstack:apply': 'DEVSTACK_APP=template devstack apply',
		apply: 'pnpm run devstack:apply',
		dev: 'DEVSTACK_APP=template devstack up',
		build:
			'pnpm run devstack:apply && DEVSTACK_APP=template tsc -b && DEVSTACK_APP=template vite build',
		preview: scripts.preview ?? 'vite preview',
		typecheck: 'pnpm run devstack:apply && tsc -b --noEmit',
		test: scripts.test ?? 'pnpm run typecheck && vitest run',
		'test:e2e': 'DEVSTACK_APP=template playwright test',
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

function applyTemplateCutoverFixups(templateDir: string): void {
	const oldGeneratedMetadataComment =
		/\/\/ Codegen runs before Dev \(`after: \[\.\.\., codegen\]`\), so this file\n\/\/ existing implies hello is published.*\nconst helloPackageId = packages\.hello\.packageId;/;
	const oldPackageLabel = "Package:{' '}";
	replaceInFile(join(templateDir, 'src', 'App.tsx'), [
		[
			oldGeneratedMetadataComment,
			'// `devstack apply` emits this generated package metadata after hello is\n// published, so no deployment guard is needed here.\nconst helloPackageId = packages.hello.packageId;',
		],
		[oldPackageLabel, "Move package:{' '}"],
	]);
	replaceInFile(join(templateDir, 'src', 'dapp-kit.ts'), [
		[
			'(RPC URL + MVR overrides + burner-wallet adapter)',
			'(RPC URL + MVR overrides + dev-wallet adapter)',
		],
	]);
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
pnpm test:e2e  # start the stack and run the Playwright mint flow
\`\`\`

## Project Shape

- \`devstack.config.ts\` defines the local Sui stack, accounts, Move package, and dev wallet.
- \`move/hello/\` contains the example Move package.
- \`src/dapp-kit.ts\` wires dApp Kit to the generated devstack config.
- \`src/App.tsx\` connects the wallet and calls \`hello::mint\`.

\`devstack apply\` writes runtime state under \`.devstack/\` and generated app bindings under
\`src/generated/\`; both are ignored because they are regenerated for each checkout.
`,
	);
}

function replaceInFile(
	path: string,
	replacements: ReadonlyArray<readonly [string | RegExp, string]>,
): void {
	let text = readFileSync(path, 'utf8');
	for (const [from, to] of replacements) {
		text = text.replace(from, to);
	}
	writeFileSync(path, text);
}
