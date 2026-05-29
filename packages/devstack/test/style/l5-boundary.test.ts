// L5 build-integrations boundary invariant.
//
// ARCHITECTURE.md L5 row + STYLE_GUIDE.md §7: L5 build integrations
// (`src/build-integrations/**`) consume the codegen-emitted manifest +
// the `build-integrations/runtime/` canonical substrate. They MUST NOT
// reach into any L2 plugin module (`src/plugins/**`) — that's the
// L5→L2 violation. Cross-layer contract shapes a build integration
// needs (e.g. wallet constants) live in `src/contracts/` (canonical
// case: `src/contracts/wallet-protocol.ts`, which lifted the wallet
// constants that previously forced a `build-integrations` → `plugins`
// edge).
//
// This guard models on `l4-boundary.test.ts`: walk every source file
// under `build-integrations/` and assert no `import ... from
// '../../plugins/...'` (or the `export ... from` re-export variant)
// survives.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');

const BUILD_INTEGRATIONS_DIR = 'src/build-integrations';

const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{
	readonly description: string;
	readonly regex: RegExp;
}> = [
	{
		// `import ... from '../../plugins/...'` — the L5→L2 edge.
		description: 'L2 plugin module via import (../../plugins/...)',
		regex: /import\s+(?:type\s+)?[^'"]*\sfrom\s+['"](?:\.\.\/)+plugins\//,
	},
	{
		// `export ... from '../../plugins/...'` — the re-export variant of
		// the same L5→L2 edge.
		description: 'L2 plugin module via re-export (export ... from ../../plugins/...)',
		regex: /export\s+[^'"]*\sfrom\s+['"](?:\.\.\/)+plugins\//,
	},
	{
		// Bare side-effect import `import '../../plugins/...'`.
		description: 'L2 plugin module via side-effect import (import ../../plugins/...)',
		regex: /import\s+['"](?:\.\.\/)+plugins\//,
	},
];

const collectSourceFiles = (dir: string): string[] => {
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

describe('L5 build-integrations boundary', () => {
	const absDir = join(packageRoot, BUILD_INTEGRATIONS_DIR);
	const files = collectSourceFiles(absDir);

	it(`${BUILD_INTEGRATIONS_DIR} contains at least one source file`, () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const { description, regex } of FORBIDDEN_IMPORT_PATTERNS) {
		it(`${BUILD_INTEGRATIONS_DIR} files never import ${description}`, () => {
			const offenders: Array<{ file: string; line: string }> = [];
			for (const file of files) {
				const body = readFileSync(file, 'utf8');
				for (const line of body.split('\n')) {
					if (regex.test(line)) {
						offenders.push({ file: file.slice(packageRoot.length + 1), line: line.trim() });
					}
				}
			}
			expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
		});
	}
});
