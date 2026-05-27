// `as unknown as` audit at user-facing + plugin barrel surfaces.
//
// STYLE_GUIDE §5 mandates that the user-facing API and plugin barrels
// expose typed surfaces — every `as unknown as` cast at those layers
// is a TS inference workaround that needs justification. This test
// pins the sanctioned set so:
//   1. New unsanctioned casts at user-facing surfaces fail CI.
//   2. The sanctioned set acts as a backlog signal — casts that get
//      removed (e.g. when a typed substrate seam lands) leave entries
//      here that must be deleted, surfacing the cleanup.
//
// Scope of the audit (the user-facing surface):
//   - `src/api/`              — devstack composer + the `with` form.
//   - `src/plugins/*/index.ts` — every plugin barrel (the public
//                                 plugin-author surface).
//   - `src/plugins/host-service/service.ts` — host-service is a
//                                 plugin-internal service module that
//                                 nonetheless surfaces casts at the
//                                 spawned-process iterable boundary.
//
// Substrate / runtime / orchestrator code is OUT of scope here —
// those layers have their own typed-error + decode discipline (see
// STYLE_GUIDE §2 + §20). Test code is also out of scope.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

const SURFACE_DIRS: ReadonlyArray<string> = [
	'src/api',
] as const;

/** Extra individual files (relative to repo root) that are in scope but
 *  don't fit the per-directory pattern. */
const SURFACE_EXTRA_FILES: ReadonlyArray<string> = [
	'src/plugins/account/index.ts',
	'src/plugins/deepbook/index.ts',
	'src/plugins/host-service/index.ts',
	'src/plugins/host-service/service.ts',
	'src/plugins/wallet/index.ts',
] as const;

/** The sanctioned-cast manifest. Each entry names the file (relative
 *  to repo root) and the count of `as unknown as` occurrences inside
 *  it. The test fails when the on-disk count diverges from the
 *  manifest — new casts surface; deleted casts also surface so the
 *  reviewer must update the manifest, naming the lift that removed
 *  the cast.
 *
 *  Each entry's `reason` is the doc-anchor — find the matching inline
 *  comment in the file to understand WHY the cast is sanctioned. */
const SANCTIONED: ReadonlyArray<{
	readonly path: string;
	readonly count: number;
	readonly reason: string;
}> = [
	{
		path: 'src/api/define-devstack.ts',
		count: 2,
		reason:
			'Symbol-keyed property read (TS structural typing does not propagate symbol slots) + ' +
			'final return-type cast widening the runtime Stack from the unknown-member tuple to ' +
			'the typed ComposedMembers<Members> shape.',
	},
	{
		path: 'src/api/define-devstack-with.ts',
		count: 1,
		reason:
			'Return-type cast from defineDevstack`s ComposedMembers<Members[number][]> back to the ' +
			'pinned ComposedMembers<readonly [...Members]> shape required by the `with` form`s ' +
			'type prototype.',
	},
	{
		path: 'src/plugins/account/index.ts',
		count: 2,
		reason:
			'Dependent-tuple inference workaround — `Funding` is a const-tuple parameter whose ' +
			'shape TS cannot infer through the resolved options. Both casts re-narrow at the boundary.',
	},
	{
		path: 'src/plugins/deepbook/index.ts',
		count: 4,
		reason:
			'Factory option-narrowing path (pools / pyth / deps tuple) — generic-tuple element ' +
			'projection past optional members. TS cannot keep the per-element types through ' +
			'`flatMap` / conditional inclusion.',
	},
	{
		path: 'src/plugins/host-service/index.ts',
		count: 1,
		reason:
			'Generic default for `options.after ?? []` — the empty-tuple literal needs an ' +
			'`After`-shaped widening that TS cannot infer from the conditional default.',
	},
	{
		path: 'src/plugins/host-service/service.ts',
		count: 2,
		reason:
			'Node child_process `stdout` / `stderr` are `Readable | null` upstream but the consumer ' +
			'iterates them as `AsyncIterable<Uint8Array>`; the cast bridges the type stream surfaces.',
	},
	{
		path: 'src/plugins/wallet/index.ts',
		count: 1,
		reason:
			'Account-member id-prefix filter — the substrate-owned `ACCOUNT_RESOURCE_ID_PREFIX` ' +
			'probe is the typed convention but TS does not propagate the resource-id discriminator ' +
			'through the filtered member array.',
	},
];

const collectSourceFiles = (dir: string, acc: Array<string>): Array<string> => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			collectSourceFiles(full, acc);
		} else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			acc.push(full);
		}
	}
	return acc;
};

const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const countCasts = (source: string): number => {
	const stripped = stripComments(source);
	const matches = stripped.match(/\bas\s+unknown\s+as\b/g);
	return matches?.length ?? 0;
};

interface SurfaceFinding {
	readonly path: string;
	readonly count: number;
}

const surveySurface = (): Array<SurfaceFinding> => {
	const out: Array<SurfaceFinding> = [];
	for (const dir of SURFACE_DIRS) {
		const full = join(REPO_ROOT, dir);
		const files = collectSourceFiles(full, []);
		for (const file of files) {
			const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
			const count = countCasts(readFileSync(file, 'utf8'));
			if (count > 0) out.push({ path: rel, count });
		}
	}
	for (const file of SURFACE_EXTRA_FILES) {
		const full = join(REPO_ROOT, file);
		const count = countCasts(readFileSync(full, 'utf8'));
		if (count > 0) out.push({ path: file, count });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
};

describe('user-surface `as unknown as` discipline', () => {
	it('sanctioned set matches the on-disk surface', () => {
		const findings = surveySurface();
		const findingsByPath = new Map(findings.map((f) => [f.path, f.count]));
		const sanctionedByPath = new Map(SANCTIONED.map((s) => [s.path, s.count]));

		const newCasts: Array<string> = [];
		const removedCasts: Array<string> = [];
		const driftedCasts: Array<string> = [];

		for (const [path, count] of findingsByPath) {
			const expected = sanctionedByPath.get(path);
			if (expected === undefined) {
				newCasts.push(`  - ${path} (${count} cast${count === 1 ? '' : 's'})`);
			} else if (expected !== count) {
				driftedCasts.push(
					`  - ${path} (expected ${expected}, found ${count})`,
				);
			}
		}
		for (const [path, count] of sanctionedByPath) {
			if (!findingsByPath.has(path)) {
				removedCasts.push(`  - ${path} (sanctioned ${count}, none on disk)`);
			}
		}

		if (newCasts.length > 0 || removedCasts.length > 0 || driftedCasts.length > 0) {
			const parts: Array<string> = [];
			if (newCasts.length > 0) {
				parts.push(
					`Unsanctioned \`as unknown as\` casts at user-facing surfaces:\n${newCasts.join('\n')}\n` +
						`Either lift the cast to a typed seam in substrate / plugin contracts, or ` +
						`add an entry to SANCTIONED with a justification.`,
				);
			}
			if (removedCasts.length > 0) {
				parts.push(
					`Sanctioned casts no longer on disk (good — but update the manifest):\n` +
						`${removedCasts.join('\n')}`,
				);
			}
			if (driftedCasts.length > 0) {
				parts.push(
					`Sanctioned cast counts drifted (file gained / lost casts):\n${driftedCasts.join('\n')}`,
				);
			}
			throw new Error(parts.join('\n\n'));
		}
		expect(findings.length).toBe(SANCTIONED.length);
	});

	it('every sanctioned entry carries a non-empty reason', () => {
		for (const entry of SANCTIONED) {
			expect(entry.reason.length).toBeGreaterThan(0);
		}
	});
});
