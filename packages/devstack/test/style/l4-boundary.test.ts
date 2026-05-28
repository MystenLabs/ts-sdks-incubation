// L4 surfaces boundary invariant.
//
// ARCHITECTURE.md L4 row: surfaces consume only typed event/command
// channels (`CommandPublisher` / `EventSubscriber`) + the cascade
// formatter + codegen-emitted helpers. They MUST NOT import L1
// runtime adapters directly, any L2 plugin module, or L3 orchestrator
// barrels.
//
// STYLE_GUIDE.md §7 carve-out: `cli/main.ts`-side modules
// (`cli/prune-direct.ts`, `cli/doctor-probes.ts`, `cli/snapshot-reader.ts`)
// are L4-adjacent infrastructure, NOT L4 surfaces — they may import
// L3 orchestrator / substrate barrels. This test only checks the
// pure-surface directories.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');

const SURFACE_DIRS = ['src/surfaces/cli', 'src/surfaces/tui'] as const;

const FORBIDDEN_IMPORT_PATTERNS: ReadonlyArray<{
	readonly description: string;
	readonly regex: RegExp;
}> = [
	{
		description: 'L1 docker runtime adapter (../../../runtime/docker/...)',
		regex: /from\s+['"](?:\.\.\/)+runtime\/docker\//,
	},
	{
		description: 'L2 plugin module (../../../plugins/...)',
		regex: /from\s+['"](?:\.\.\/)+plugins\//,
	},
	{
		// L4 surfaces MAY import from an orchestrator's curated `index.ts`
		// barrel — that barrel is the promoted typed-shape + predicate
		// surface (e.g. `LifecyclePruneGroup`, `SharedGroupKind`,
		// `defaultLifecyclePruneSelection`) the orchestrator publishes for
		// surface consumers so the surface never reimplements the L3
		// policy. Deeper subpaths (engine modules) remain forbidden — they
		// reach into orchestrator implementation details.
		description: 'L3 orchestrator submodule (../../../orchestrators/<name>/<non-index>)',
		regex: /from\s+['"](?:\.\.\/)+orchestrators\/[^/'"]+\/(?!index\.ts['"])/,
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

describe('L4 surfaces boundary', () => {
	for (const relDir of SURFACE_DIRS) {
		const absDir = join(packageRoot, relDir);
		const files = collectSourceFiles(absDir);

		it(`${relDir} contains at least one source file`, () => {
			expect(files.length).toBeGreaterThan(0);
		});

		for (const { description, regex } of FORBIDDEN_IMPORT_PATTERNS) {
			it(`${relDir} files never import ${description}`, () => {
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
	}
});
