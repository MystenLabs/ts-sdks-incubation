#!/usr/bin/env -S node --experimental-strip-types
// Build-output smoke test. Runs AFTER `pnpm build` and asserts:
//
//   1. Every entry point declared in package.json `exports` exists at
//      its declared path with a matching `.d.mts`.
//   2. Plugin assets that the build copies non-bundle (Dockerfiles,
//      entrypoint scripts) landed in dist/plugins/<name>/.
//   3. Each entry point is dynamically importable — catches runtime
//      breakage that typecheck doesn't see (the tsup→tsdown migration
//      regressed exactly this surface).
//
// Run with: `node --experimental-strip-types scripts/smoke-test-build.ts`
// or `pnpm exec tsx scripts/smoke-test-build.ts`.
//
// Exits 0 on success, 1 with a list of missing/broken outputs on
// failure. Designed to be a CI step right after build.

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

function assertExists(label: string, path: string): boolean {
	if (!existsSync(path)) {
		fail(label, `missing: ${path}`);
		return false;
	}
	return true;
}

interface ExportEntry {
	types?: string;
	import?: string;
}

function readPackageExports(): Record<string, ExportEntry> {
	const pkgPath = resolve(pkgRoot, 'package.json');
	const raw = readFileSync(pkgPath, 'utf8');
	const pkg = JSON.parse(raw) as { exports?: Record<string, ExportEntry> };
	return pkg.exports ?? {};
}

async function main(): Promise<number> {
	// 1. Every entry point in `exports` resolves to an existing file.
	const exports = readPackageExports();
	for (const [subpath, entry] of Object.entries(exports)) {
		if (typeof entry === 'string' || !entry) continue;
		if (entry.import !== undefined) {
			assertExists(`exports[${subpath}].import`, resolve(pkgRoot, entry.import));
		}
		if (entry.types !== undefined) {
			assertExists(`exports[${subpath}].types`, resolve(pkgRoot, entry.types));
		}
	}

	// 2. Plugin assets that tsdown's `copy` step mirrors non-bundle.
	const assetTargets = [
		'dist/plugins/sui/Dockerfile',
		'dist/plugins/sui/entrypoint.sh',
		'dist/plugins/seal/Dockerfile',
	];
	for (const rel of assetTargets) {
		assertExists(`asset ${rel}`, resolve(pkgRoot, rel));
	}

	// 3. Each entry point is dynamically importable. Catches
	// invalid-syntax / circular-import regressions the type-only check
	// can miss.
	for (const [subpath, entry] of Object.entries(exports)) {
		if (typeof entry === 'string' || !entry?.import) continue;
		const fileUrl = pathToFileURL(resolve(pkgRoot, entry.import)).href;
		try {
			await import(fileUrl);
		} catch (err) {
			fail(`import ${subpath}`, `${(err as Error).message}`);
		}
	}

	if (failures.length === 0) {
		// eslint-disable-next-line no-console
		console.log(`smoke-test-build: ${Object.keys(exports).length} entry points OK`);
		return 0;
	}
	// eslint-disable-next-line no-console
	console.error('smoke-test-build: FAILURES');
	for (const { target, reason } of failures) {
		// eslint-disable-next-line no-console
		console.error(`  ${target}: ${reason}`);
	}
	return 1;
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		// eslint-disable-next-line no-console
		console.error(`smoke-test-build: unexpected error: ${(err as Error).stack ?? err}`);
		process.exit(1);
	});
