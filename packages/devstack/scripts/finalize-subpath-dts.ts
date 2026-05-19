// Lifts the `.d.ts` files emitted by `tsc -p tsconfig.subpaths.json` into
// the final `dist/<subpath>/*.d.mts` paths so they match the existing
// tsdown-emitted `.mjs` neighbors. Run after `tsc --emitDeclarationOnly`.
//
// Why this script exists: see the long comment in `tsdown.config.ts` —
// rolldown-plugin-dts crashes on transitive postcss types when bundling
// these subpaths, so we delegate dts emission to tsc. tsc emits `.d.ts`
// with `.js` import specifiers; we rename the files and rewrite the
// specifiers so the artefacts behave like ESM `.d.mts`.

import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const tmpRoot = join(pkgRoot, 'dist', '.dts-subpaths-tmp');
const distRoot = join(pkgRoot, 'dist');

const SUBPATHS = ['vitest', 'playwright', 'vite'] as const;

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(p)));
		else out.push(p);
	}
	return out;
}

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

// Rewrite relative-import specifiers ending in `.js` to `.mjs` so the
// emitted dts lines up with tsdown's `.mjs`/`.d.mts` artefacts. Only
// touches relative paths (`./`, `../`) — bare module specifiers stay
// untouched. The regex handles both `import` and `export ... from`.
function rewriteJsToMjs(src: string): string {
	return src.replace(
		/((?:import|export)[^;\n]*?from\s+['"])(\.{1,2}\/[^'"]+?)\.js(['"])/g,
		(_m, prefix: string, path: string, quote: string) => `${prefix}${path}.mjs${quote}`,
	);
}

async function processSubpath(name: string): Promise<void> {
	const srcDir = join(tmpRoot, name);
	const destDir = join(distRoot, name);
	if (!(await exists(srcDir))) {
		throw new Error(`expected tsc dts output at ${srcDir}`);
	}
	const files = (await walk(srcDir)).filter((f) => f.endsWith('.d.ts'));
	for (const file of files) {
		const rel = file.slice(srcDir.length + 1);
		const destFile = join(destDir, rel.replace(/\.d\.ts$/, '.d.mts'));
		const original = await readFile(file, 'utf-8');
		await writeFile(destFile, rewriteJsToMjs(original), 'utf-8');
	}
}

async function main(): Promise<void> {
	for (const subpath of SUBPATHS) {
		await processSubpath(subpath);
	}
	// Drop the temp dir entirely once we've copied what we need.
	await rm(tmpRoot, { recursive: true, force: true });
	console.log('finalized dts for subpaths:', SUBPATHS.join(', '));
}

await main();
