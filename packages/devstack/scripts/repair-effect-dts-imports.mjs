import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const distRoot = new URL('../dist/', import.meta.url).pathname;

const effectInternalImport =
	/(["'])(?:(?:\.\.\/)+node_modules\/\.pnpm\/effect@[^/]+\/node_modules\/effect\/dist\/|node_modules\/effect\/dist\/)([^"']+?)(?:\.mjs)?\1/g;
const effectJsSubpathImport = /(["'])effect\/([^"']+?)\.js\1/g;

let changed = 0;

const visit = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			visit(path);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.d.mts')) continue;

		const before = readFileSync(path, 'utf8');
		const after = before
			.replace(effectInternalImport, (_match, quote, subpath) => {
				changed += 1;
				return `${quote}effect/${subpath}${quote}`;
			})
			.replace(effectJsSubpathImport, (_match, quote, subpath) => {
				changed += 1;
				return `${quote}effect/${subpath}${quote}`;
			});
		if (after !== before) {
			writeFileSync(path, after);
		}
	}
};

visit(distRoot);

if (changed > 0) {
	process.stdout.write(`repaired ${changed} Effect declaration import(s)\n`);
}
