// Orphan-export guard (STYLE_GUIDE.md §5: "Code either WORKS or DOESN'T
// EXIST. No orphan exports waiting for a wiring layer.").
//
// SCOPE — deliberately narrow + reliable, not whole-repo export
// reachability (which is flaky: TypeScript re-exports, type-only
// positions, and codegen consumers all defeat naive reachability and
// produce false positives).
//
// This guard checks ONE thing, precisely: every NAMED RE-EXPORT a
// plugin / orchestrator barrel publishes via `export { X } from
// './module.ts'` (or `export type { X } from ...`) must be REFERENCED
// somewhere in the repo — by ANY `.ts`/`.tsx` file under `src/` or
// `test/` OTHER than the declaring barrel itself. A barrel symbol that
// no file anywhere mentions is a true orphan: it survives only as a
// re-export "waiting for a wiring layer" and is exactly the §5 debt.
//
// Why "referenced anywhere" rather than "imported THROUGH the barrel":
// orchestrator/plugin internals legitimately import a symbol directly
// from its implementation module (`./capture.ts`) while the barrel
// re-export remains the published L3/L2 surface for L4 surfaces +
// `cli/main.ts`-adjacent infra. Requiring the consumer to go through
// the barrel would flag those deliberate published surfaces, so we use
// the weaker, false-positive-resistant "mentioned anywhere" signal.
// The barrel's own body is excluded so a symbol isn't kept alive purely
// by its own re-export line.
//
// Scope boundaries:
//   * Only `export { ... } from '...'` / `export type { ... } from
//     '...'` RE-EXPORTS are inspected — locally-declared exports
//     (`export const`, `export function`) in non-barrel modules are out
//     of scope (they're covered by `noUnusedLocals` + tree-shaking).
//   * `export * as NS from '...'` namespace re-exports are out of scope
//     (the namespace object, not individual symbols, is the surface).
//
// Calibrated GREEN on the current tree: all plugin + orchestrator
// barrels have zero orphan re-exports.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');
const SRC = join(packageRoot, 'src');
const TEST = join(packageRoot, 'test');

const collectFiles = (dir: string): string[] => {
	const out: string[] = [];
	const visit = (current: string): void => {
		let entries: ReadonlyArray<string>;
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				visit(full);
				continue;
			}
			if (!stat.isFile()) continue;
			if (!/\.(ts|tsx)$/.test(entry)) continue;
			out.push(full);
		}
	};
	visit(dir);
	return out;
};

// Parse the named symbols of every `export { ... } from '...'` /
// `export type { ... } from '...'` re-export block in a barrel. The
// exported name is what survives an `X as Y` alias (`Y`).
const RE_EXPORT_BLOCK = /export\s*(type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;

const parseReExports = (barrelBody: string): ReadonlyArray<string> => {
	const symbols: string[] = [];
	for (const match of barrelBody.matchAll(RE_EXPORT_BLOCK)) {
		const block = match[2] ?? '';
		for (const rawPart of block.split(',')) {
			const part = rawPart.trim().replace(/^type\s+/, '');
			if (part === '') continue;
			const aliasMatch = part.match(/\s+as\s+([A-Za-z_$][\w$]*)/);
			const name = aliasMatch?.[1] ?? part.replace(/\s+as\s+.*/, '').trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) symbols.push(name);
		}
	}
	return symbols;
};

const collectBarrels = (): ReadonlyArray<string> => {
	const barrels: string[] = [];
	for (const group of ['plugins', 'orchestrators'] as const) {
		const groupDir = join(SRC, group);
		let names: ReadonlyArray<string>;
		try {
			names = readdirSync(groupDir);
		} catch {
			continue;
		}
		for (const name of names) {
			const barrel = join(groupDir, name, 'index.ts');
			try {
				if (statSync(barrel).isFile()) barrels.push(barrel);
			} catch {
				// not a barrel-bearing directory
			}
		}
	}
	return barrels;
};

describe('no orphan barrel re-exports', () => {
	// All source + test bodies, read once, used as the reference corpus.
	const corpus = [...collectFiles(SRC), ...collectFiles(TEST)].map(
		(file) => [file, readFileSync(file, 'utf8')] as const,
	);
	const barrels = collectBarrels();

	it('discovers plugin + orchestrator barrels', () => {
		expect(barrels.length).toBeGreaterThan(0);
	});

	for (const barrel of barrels) {
		const rel = barrel.slice(packageRoot.length + 1);
		const barrelBody = readFileSync(barrel, 'utf8');
		const symbols = parseReExports(barrelBody);
		if (symbols.length === 0) continue;

		it(`${rel}: every re-exported symbol is referenced somewhere`, () => {
			const orphans: string[] = [];
			for (const symbol of symbols) {
				const wordRegex = new RegExp(`\\b${symbol}\\b`);
				let referenced = false;
				for (const [file, body] of corpus) {
					if (file === barrel) continue; // don't let the re-export keep itself alive
					if (wordRegex.test(body)) {
						referenced = true;
						break;
					}
				}
				if (!referenced) orphans.push(symbol);
			}
			expect(orphans, `Orphan re-exports in ${rel}: ${JSON.stringify(orphans)}`).toEqual([]);
		});
	}
});
