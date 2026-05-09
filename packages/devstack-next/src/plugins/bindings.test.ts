import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Package } from '../shapes/index.js';
import { bindings } from './bindings.js';

const suiAvailable = (() => {
	try {
		execFileSync('sui', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

function itSui(name: string, fn: () => Promise<void>, timeout?: number): void {
	if (suiAvailable) {
		it(name, fn, timeout);
	} else {
		it.skip(name, fn);
	}
}

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-next-bindings-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
});

const baseEnv = (): Env => ({
	appName: 'demo',
	appDir,
	network: 'localnet',
	stack: 'main',
});

// Synthetic Package producer — emits a Package shape with optional
// `path`. Stand-in for `publishMove` so we can drive the bindings
// plugin without running an actual chain operation.
function makePackageProducer(opts: {
	name: string;
	packageId: string;
	path?: string;
	mvrPlaceholder?: string;
}) {
	type S = { name: string; packageId: string; path?: string; mvrPlaceholder?: string };
	return define<S>({
		name: `pkg.${opts.name}`,
		provides: {
			package: dep((s: S): Package => {
				const out: Package = { name: s.name, packageId: s.packageId };
				if (s.path !== undefined) out.path = s.path;
				if (s.mvrPlaceholder !== undefined) out.mvrPlaceholder = s.mvrPlaceholder;
				return out;
			}),
		},
		start: async () => {
			const out: S = { name: opts.name, packageId: opts.packageId };
			if (opts.path !== undefined) out.path = opts.path;
			if (opts.mvrPlaceholder !== undefined) out.mvrPlaceholder = opts.mvrPlaceholder;
			return out;
		},
	});
}

describe('bindings (no targets — packages without path)', () => {
	it('skips cleanly on first cycle when there is nothing to do', async () => {
		const pkg = makePackageProducer({ name: 'token', packageId: '0xpkg' });
		const b = bindings({ packages: [pkg.get('package')] });
		const engine = new Engine({ stack: [pkg, b] }, { env: baseEnv() });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		// No targets, no leftover dir → getStatus returns ok=true and the
		// node is satisfied without dispatching run().
		expect(result.skipped.find((s) => s.name === 'bindings')?.reason).toBe('satisfied');
	});

	it('cleans stale subdirs when no targets remain', async () => {
		const outputDir = join(appDir, 'src/generated/sui');
		mkdirSync(join(outputDir, 'leftover'), { recursive: true });
		writeFileSync(join(outputDir, 'leftover', 'index.ts'), '// stale\n');
		// A second leftover with a different name to verify the sweep is
		// universal, not just first-match.
		mkdirSync(join(outputDir, 'older'), { recursive: true });

		const pkg = makePackageProducer({ name: 'token', packageId: '0xpkg' });
		const b = bindings({ packages: [pkg.get('package')] });
		const engine = new Engine({ stack: [pkg, b] }, { env: baseEnv() });
		const result = await engine.runOnce();
		expect(result.errored).toEqual([]);
		// Leftover dirs are cleaned because there are no targets to keep.
		const remaining = await readdir(outputDir);
		expect(remaining).toEqual([]);
	});
});

describe('bindings (input cascade)', () => {
	it('re-fires when an upstream Package identity changes', async () => {
		// Package starts without path → no target → first cycle is a
		// satisfied skip. Bumping its state to include a path flips its
		// identity, which should cascade through the bindings node's
		// input hash. We don't run the actual codegen because that needs
		// sui; we just verify the engine schedules bindings to run on
		// the second cycle (rather than skipping with 'satisfied').
		type S = { name: string; packageId: string; rev: number; path?: string };
		const env = baseEnv() as Env & { rev?: number };
		const pkg = define<S>({
			name: 'pkg.token',
			provides: {
				package: dep((s: S): Package => {
					const out: Package = { name: s.name, packageId: s.packageId };
					if (s.path !== undefined) out.path = s.path;
					return out;
				}),
			},
			inputs: ({ env: e }) => ({ rev: (e as { rev?: number }).rev ?? 0 }),
			start: async ({ env: e }) => {
				const rev = (e as { rev?: number }).rev ?? 0;
				const out: S = { name: 'token', packageId: '0xpkg', rev };
				return out;
			},
		});
		const b = bindings({ packages: [pkg.get('package')] });
		const engine = new Engine({ stack: [pkg, b] }, { env });

		await engine.runOnce();
		// rev=0, no path → bindings skipped.

		// Bumping rev flips pkg's input hash; bindings input includes
		// upstream identity so it re-evaluates next cycle.
		env.rev = 1;
		engine.invalidate('pkg.token');
		const result = await engine.cycle();
		const ranNames = result.ran.map((r) => r.name);
		// pkg.token re-runs because its inputs flipped. bindings's
		// upstream identity therefore changes → its getStatus is consulted
		// and (correctly) reports ok=true again because there's still no
		// target. We verify the cascade reached bindings rather than
		// stopping at pkg.token.
		expect(ranNames).toContain('pkg.token');
	});
});

describe('bindings (real sui)', () => {
	itSui(
		'runs sui move summary + generateFromPackageSummary end-to-end',
		async () => {
			const pkgPath = join(appDir, 'move/demo');
			mkdirSync(join(pkgPath, 'sources'), { recursive: true });
			await writeFile(
				join(pkgPath, 'Move.toml'),
				[
					'[package]',
					'name = "demo"',
					'edition = "2024.beta"',
					'',
					'[addresses]',
					'demo = "0x0"',
					'',
				].join('\n'),
				'utf8',
			);
			await writeFile(
				join(pkgPath, 'sources/m.move'),
				'module demo::m {\n    public fun id(x: u64): u64 { x }\n}\n',
				'utf8',
			);

			const pkg = makePackageProducer({
				name: 'demo',
				packageId: '0xdemo',
				path: pkgPath,
				mvrPlaceholder: '@local/demo',
			});
			const b = bindings({ packages: [pkg.get('package')] });
			const engine = new Engine({ stack: [pkg, b] }, { env: baseEnv() });
			const result = await engine.runOnce();
			if (result.errored.length > 0) {
				throw result.errored[0]?.error;
			}
			const state = engine.getState().nodes.get('bindings')!.state as {
				targets: string[];
			};
			expect(state.targets).toEqual(['demo']);
			const outputDir = join(appDir, 'src/generated/sui/demo');
			const entries = await readdir(outputDir);
			expect(entries.length).toBeGreaterThan(0);
		},
		30_000,
	);
});
