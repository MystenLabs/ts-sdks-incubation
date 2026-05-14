// Build-output smoke test. Runs AFTER `pnpm build` and asserts:
//
//   1. Every `package.json#exports` entry points at a file that exists
//      on disk (catches dist outputs that the build silently dropped).
//   2. Each entry's `import` target is dynamically loadable from this
//      process — catches runtime breakage that typecheck doesn't see
//      (e.g. an ESM cycle, a missing copy: asset, or a peer-dep import
//      whose resolution shifted under a dep bump).
//   3. Each entry's `types` target is also present.
//
// Imports happen from this package's actual `dist/` rather than a
// staged temp dir — the workspace's resolved `node_modules` is what
// makes peer deps (`@mysten/dapp-kit-core`, `@playwright/test`,
// `vitest`) discoverable. A standalone consumer with no peer deps
// installed would fail differently, and that's a separate failure
// mode worth its own test if/when it matters.
//
// Wired into `prepublishOnly`. Exit code reflects whether anything
// went wrong; the listing on stderr is human-readable.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

interface Failure {
	target: string;
	reason: string;
}
const failures: Failure[] = [];

function fail(target: string, reason: string): void {
	failures.push({ target, reason });
}

function assertExists(label: string, path: string): void {
	if (!existsSync(path)) fail(label, `missing: ${path}`);
}

interface ExportEntry {
	types?: string;
	import?: string;
}

function readExports(): Record<string, ExportEntry> {
	const raw = readFileSync(resolve(pkgRoot, 'package.json'), 'utf8');
	const pkg = JSON.parse(raw) as { exports?: Record<string, ExportEntry> };
	return pkg.exports ?? {};
}

async function main(): Promise<number> {
	const exports = readExports();

	// Phase 1 — file existence checks.
	for (const [subpath, entry] of Object.entries(exports)) {
		if (typeof entry === 'string' || !entry) continue;
		if (entry.import !== undefined) {
			assertExists(`exports[${subpath}].import`, resolve(pkgRoot, entry.import));
		}
		if (entry.types !== undefined) {
			assertExists(`exports[${subpath}].types`, resolve(pkgRoot, entry.types));
		}
	}

	// Phase 2 — copy: assets that runtime code resolves via
	// `new URL('./<file>', import.meta.url)`. The build's copy step
	// is the only place these land — a silent miss surfaces here.
	const copyAssets = [
		'dist/plugins/sui/docker/Dockerfile',
		'dist/plugins/sui/docker/entrypoint.sh',
		'dist/plugins/seal/docker/Dockerfile',
		'dist/plugins/walrus/docker/upstream.Dockerfile',
		'dist/plugins/walrus/docker/wrapper.Dockerfile',
		'dist/plugins/walrus/docker/deploy.sh',
		'dist/plugins/walrus/docker/run.sh',
	];
	for (const rel of copyAssets) assertExists(`asset ${rel}`, resolve(pkgRoot, rel));

	// Phase 3 — dynamic import every entry point. Peer deps resolve
	// via the workspace node_modules tree under pkgRoot.
	let importable = 0;
	for (const [subpath, entry] of Object.entries(exports)) {
		if (typeof entry === 'string' || !entry?.import) continue;
		const fileUrl = pathToFileURL(resolve(pkgRoot, entry.import)).href;
		try {
			await import(fileUrl);
			importable += 1;
		} catch (err) {
			fail(`import ${subpath}`, (err as Error).message);
		}
	}

	if (failures.length === 0) {
		console.log(`smoke-test: ${Object.keys(exports).length} exports + ${copyAssets.length} assets OK (${importable} imported cleanly).`);
		return 0;
	}
	console.error('smoke-test: FAILURES');
	for (const { target, reason } of failures) {
		console.error(`  ${target}: ${reason}`);
	}
	return 1;
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(`smoke-test: unexpected error: ${(err as Error).stack ?? err}`);
		process.exit(1);
	});
