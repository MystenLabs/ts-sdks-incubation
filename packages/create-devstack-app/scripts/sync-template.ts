// Copies `examples/_template/` into `packages/create-devstack-app/template/`
// at build time so the published package is self-contained. Skips generated
// dirs (`node_modules`, `dist`, `.devstack`, `.turbo`, build-tsbuildinfo).
//
// Also rewrites `template/package.json` so the published package can be
// `pnpm install`-ed in a fresh app outside the monorepo:
//   - `workspace:*` → `^<version>` from each workspace package's
//     package.json (so a freshly scaffolded app pins a published version
//     of `@mysten-incubation/devstack`, not a workspace path).
//   - `catalog:` → the version recorded in `pnpm-workspace.yaml` under
//     `catalog:` (so React, dapp-kit, etc. resolve outside the monorepo).
// Without this rewriting, `pnpm create @mysten-incubation/devstackpp
// my-app && cd my-app && pnpm install` fails because pnpm can't resolve
// monorepo-only specifiers.
//
// Run via `pnpm -F @mysten-incubation/create-devstack-app run sync-template`,
// or as part of `pnpm build` (the package script chains the two).

import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SRC = resolve(REPO_ROOT, 'examples', '_template');
const DST = resolve(PKG_ROOT, 'template');

if (!existsSync(SRC)) {
	throw new Error(`sync-template: source ${SRC} not found. The repo layout may have changed.`);
}

if (existsSync(DST)) {
	rmSync(DST, { recursive: true, force: true });
}
mkdirSync(DST, { recursive: true });

const SKIP = new Set([
	'node_modules',
	'dist',
	'.devstack',
	'.turbo',
	'tsconfig.app.tsbuildinfo',
	'tsconfig.node.tsbuildinfo',
]);

cpSync(SRC, DST, {
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

resolveTemplateDeps(DST, REPO_ROOT);

process.stdout.write(`synced ${SRC} → ${DST}\n`);

interface PkgJson {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
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

	writeFileSync(pkgPath, `${JSON.stringify(json, null, '\t')}\n`);
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
