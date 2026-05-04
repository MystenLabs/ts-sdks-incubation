// Unit tests for runOneShot's `actionScope` walk. Exercises the
// internal `scopeActions` helper indirectly through runOneShot's plugin
// expansion, but with mocked Reconciler so we observe which actions
// reached the cycle.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcilerCycleMock = vi.hoisted(() => vi.fn());

vi.mock('./reconcile.js', async () => {
	const actual = await vi.importActual<typeof import('./reconcile.js')>('./reconcile.js');
	return {
		...actual,
		Reconciler: vi.fn().mockImplementation(() => ({
			cycle: reconcilerCycleMock,
			// runOneShot calls serializeState() at end-of-cycle to persist
			// per-action state into the manifest. Tests don't assert on it,
			// so an empty record is fine.
			serializeState: () => ({}),
		})),
	};
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOneShot } from './one-shot.js';
import type { Action, Plugin, PublishAction } from '../core/types.js';
import { definePlugin } from '../plugin.js';
import { buildImage } from '../actions/build.js';
import { emit } from '../actions/emit.js';
import { register } from '../actions/register.js';
import { applyFilter } from '../cli/filters.js';

const stubAction = (
	name: string,
	kind: 'Build' | 'Publish' | 'Register' | 'Emit',
	opts: { needs?: string[]; dependsOnKind?: string[] } = {},
) => {
	if (kind === 'Build') {
		return buildImage({
			name,
			needs: opts.needs,
			inputs: { tag: name },
			run: async () => {},
			getStatus: async () => ({ ok: true, detail: '' }),
		});
	}
	if (kind === 'Publish') {
		// Construct a raw PublishAction stub — the unified `publish()`
		// factory bakes in a real run body that talks to the chain;
		// tests for scope-walking just need the action shape.
		return {
			name,
			type: 'Publish',
			needs: opts.needs,
			path: '<stub>',
			inputs: { path: '<stub>' },
			run: async () => {},
			getStatus: async () => ({ ok: true, detail: '' }),
		} satisfies PublishAction as Action;
	}
	if (kind === 'Register') {
		return register({
			name,
			needs: opts.needs,
			inputs: {},
			run: async () => {},
			getStatus: async () => ({ ok: true, detail: '' }),
		});
	}
	return emit({
		name,
		needs: opts.needs,
		dependsOnKind: opts.dependsOnKind,
		inputs: {},
		run: async () => {},
		getStatus: async () => ({ ok: true, detail: '' }),
	});
};

const buildPlugin = (): Plugin =>
	definePlugin({
		name: 'app',
		actions: () => [
			stubAction('build', 'Build'),
			stubAction('a', 'Publish', { needs: ['build'] }),
			stubAction('b', 'Publish', { needs: ['build'] }),
			stubAction('c', 'Publish', { needs: ['build'] }),
			stubAction('seed', 'Register', { needs: ['a', 'b'] }),
			stubAction('codegen', 'Emit', { dependsOnKind: ['packages'] }),
		],
	});

let tmpDir: string;

beforeEach(() => {
	reconcilerCycleMock.mockReset();
	reconcilerCycleMock.mockResolvedValue({
		statuses: new Map(),
		failures: new Map(),
		dirtyKinds: new Set(),
		cycles: 1,
	});
	tmpDir = mkdtempSync(join(tmpdir(), 'devstack-scope-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const baseOpts = () => ({
	appName: 'app',
	appDir: tmpDir,
	network: 'localnet' as const,
	rpcUrl: 'http://stub',
	plugins: [buildPlugin()],
	skipHydrate: true,
	actionFilter: applyFilter,
});

describe('runOneShot — actionScope', () => {
	it('runs the full graph when actionScope is undefined', async () => {
		await runOneShot(baseOpts());
		const passed = (reconcilerCycleMock.mock.calls[0]?.[0] ?? []) as { name: string }[];
		expect(passed.map((a) => a.name).sort()).toEqual([
			'app.a',
			'app.b',
			'app.build',
			'app.c',
			'app.codegen',
			'app.seed',
		]);
	});

	it('scopes to a single Publish + its needs + every Emit', async () => {
		await runOneShot({ ...baseOpts(), actionScope: ['app.a'] });
		const passed = (reconcilerCycleMock.mock.calls[0]?.[0] ?? []) as { name: string }[];
		// app.a needs app.build → both kept; app.codegen kept (Emit). b/c/seed dropped.
		expect(passed.map((a) => a.name).sort()).toEqual(['app.a', 'app.build', 'app.codegen']);
	});

	it('scopes to a Register and pulls its transitive Publish + Build deps', async () => {
		await runOneShot({ ...baseOpts(), actionScope: ['app.seed'] });
		const passed = (reconcilerCycleMock.mock.calls[0]?.[0] ?? []) as { name: string }[];
		// seed needs a + b → both kept; both need build → kept; codegen always kept.
		expect(passed.map((a) => a.name).sort()).toEqual([
			'app.a',
			'app.b',
			'app.build',
			'app.codegen',
			'app.seed',
		]);
	});

	it('warns and drops scope entries that do not match any action', async () => {
		const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		await runOneShot({ ...baseOpts(), actionScope: ['app.does-not-exist'] });
		const passed = (reconcilerCycleMock.mock.calls[0]?.[0] ?? []) as { name: string }[];
		// No matches → only Emit survives the auto-include rule.
		expect(passed.map((a) => a.name).sort()).toEqual(['app.codegen']);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/scopeActions has no match for \[app\.does-not-exist\]/),
		);
		warn.mockRestore();
	});

	it('treats empty actionScope as "no filter"', async () => {
		await runOneShot({ ...baseOpts(), actionScope: [] });
		const passed = (reconcilerCycleMock.mock.calls[0]?.[0] ?? []) as { name: string }[];
		expect(passed.length).toBe(6);
	});
});

import { afterEach } from 'vitest';
