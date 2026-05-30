// Plugin-barrel smoke test.
//
// Why: every plugin barrel defines resource identity at module-load
// time. A single type-only-symbol leaking into a runtime computed
// property crashes EVERY barrel with `ReferenceError`. tsc is happy;
// nothing else exercises the runtime path. This test imports each
// plugin barrel via a fresh `tsx` subprocess and asserts the module
// loaded cleanly.
//
// History: a regression on 2026-05-20 had a type-only unique symbol
// referenced from a runtime factory. This test pins that plugin barrels
// do not crash during module evaluation.
//
// Implementation note: this intentionally uses one fresh subprocess
// per plugin so each barrel's module-load behavior is isolated from
// the Vitest worker's module cache and from other plugin barrels. The
// probe lives in a sibling file (`probe-load.cjs`) parameterized by the
// plugin name.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(HERE, 'probe-load.cjs');
const PLUGINS_ROOT = resolve(HERE, '..', '..', 'src', 'plugins');

const SENTINEL = 'BARREL_LOAD_OK';
const BARREL_LOAD_TIMEOUT_MS = 30_000;
const BARREL_TEST_TIMEOUT_MS = BARREL_LOAD_TIMEOUT_MS + 5_000;

// Discover plugins by reading `src/plugins/` directly so the smoke
// test auto-covers any new plugin directory. A plugin counts if it
// is a directory containing an `index.ts` barrel.
const PLUGINS = readdirSync(PLUGINS_ROOT, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isDirectory() && existsSync(resolve(PLUGINS_ROOT, entry.name, 'index.ts')),
	)
	.map((entry) => entry.name);

const loadBarrel = (plugin: string): { ok: boolean; stdout: string; stderr: string } => {
	const barrelPath = resolve(PLUGINS_ROOT, plugin, 'index.ts');
	const res = spawnSync(process.execPath, ['--import', 'tsx/esm', PROBE, barrelPath, SENTINEL], {
		encoding: 'utf8',
		timeout: BARREL_LOAD_TIMEOUT_MS,
	});
	return {
		ok: res.status === 0 && res.stdout.includes(SENTINEL),
		stdout: res.stdout ?? '',
		stderr: `${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`,
	};
};

describe('plugin barrels load without throwing', () => {
	for (const plugin of PLUGINS) {
		it(
			`plugins/${plugin}`,
			() => {
				const r = loadBarrel(plugin);
				if (!r.ok) {
					throw new Error(
						`plugins/${plugin} failed to load.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
					);
				}
				expect(r.ok).toBe(true);
			},
			BARREL_TEST_TIMEOUT_MS,
		);
	}
});
