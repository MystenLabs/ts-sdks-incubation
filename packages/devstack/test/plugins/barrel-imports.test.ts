// Plugin-barrel smoke test.
//
// Why: every plugin barrel calls `defineTag(...)` (and friends) at
// module-load time. A single type-only-symbol leaking into a runtime
// computed property crashes EVERY barrel with `ReferenceError`. tsc
// is happy; nothing else exercises the runtime path. This test
// imports each plugin barrel via a fresh `tsx` subprocess and asserts
// the module loaded cleanly.
//
// History: a regression on 2026-05-20 had `substrate/tag.ts` declare
// `_tagId` as `declare const ... unique symbol` (type-only, erased)
// and then reference that same identifier inside `defineTag`'s return
// object. The fix replaced the type-only declaration with a real
// `const _tagId = Symbol(...)`. This test pins that invariant.
//
// Implementation note: this intentionally uses one fresh subprocess
// per plugin so each barrel's module-load behavior is isolated from
// the Vitest worker's module cache and from other plugin barrels. The
// probe lives in a sibling file (`probe-load.cjs`) parameterized by the
// plugin name.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(HERE, 'probe-load.cjs');

const SENTINEL = 'BARREL_LOAD_OK';
const BARREL_LOAD_TIMEOUT_MS = 30_000;
const BARREL_TEST_TIMEOUT_MS = BARREL_LOAD_TIMEOUT_MS + 5_000;

const PLUGINS = [
	'sui',
	'account',
	'package',
	'faucet',
	'wallet',
	'coin',
	'postgres',
	'walrus',
	'seal',
	'action',
	'deepbook',
] as const;

const loadBarrel = (plugin: string): { ok: boolean; stdout: string; stderr: string } => {
	const barrelPath = resolve(HERE, '..', '..', 'src', 'plugins', plugin, 'index.ts');
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
