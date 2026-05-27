// L2 plugin sibling-boundary invariant.
//
// Plugins may depend on sibling plugin public barrels, but not on
// sibling internal modules. Cross-plugin implementation details need
// an explicit exported seam so the boundary remains reviewable.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const PLUGINS_ROOT = resolve(import.meta.dirname, '../../src/plugins');
const IMPORT_SPEC_REGEX = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;

const collectPluginFiles = (dir: string, acc: Array<string> = []): Array<string> => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			collectPluginFiles(full, acc);
			continue;
		}
		if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			acc.push(full);
		}
	}
	return acc;
};

const pluginFolder = (path: string): string | null => {
	const parts = relative(PLUGINS_ROOT, path).split(sep);
	if (parts.length < 2) return null;
	return parts[0] ?? null;
};

const isAllowedSiblingBarrel = (targetParts: ReadonlyArray<string>): boolean => {
	const subpath = targetParts.slice(1).join('/');
	return subpath === '' || subpath === 'index' || subpath === 'index.ts';
};

describe('L2 plugin sibling boundaries', () => {
	it('plugins import sibling plugins through barrels only', () => {
		const offenders: Array<{ readonly file: string; readonly spec: string }> = [];

		for (const file of collectPluginFiles(PLUGINS_ROOT)) {
			const sourcePlugin = pluginFolder(file);
			if (sourcePlugin === null) continue;

			const body = readFileSync(file, 'utf8');
			for (const match of body.matchAll(IMPORT_SPEC_REGEX)) {
				const spec = match[1];
				if (spec === undefined || !spec.startsWith('.')) continue;

				const target = resolve(dirname(file), spec);
				const targetRel = relative(PLUGINS_ROOT, target);
				if (targetRel.startsWith('..') || targetRel === '') continue;

				const targetParts = targetRel.split(sep);
				const targetPlugin = targetParts[0];
				if (targetPlugin === undefined || targetPlugin === sourcePlugin) continue;
				if (isAllowedSiblingBarrel(targetParts)) continue;

				offenders.push({
					file: relative(resolve(import.meta.dirname, '../..'), file),
					spec,
				});
			}
		}

		expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
	});
});
