import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	WARM_BASELINE_SNAPSHOT_ID,
	computeWarmFingerprint,
} from '../../../src/orchestrators/warm/fingerprint.ts';
import type { SupervisedStack } from '../../../src/substrate/runtime/supervisor/types.ts';
import type { AnyPlugin } from '../../../src/substrate/plugin.ts';
import type { DevstackOptions } from '../../../src/substrate/options.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

// -----------------------------------------------------------------------------
// Minimal fakes — the fingerprint reads ONLY id/role/section/dependsOn/watch
// off each member and `options` off the stack. We build the smallest shape
// that satisfies those reads and cast to the runtime type.
// -----------------------------------------------------------------------------

interface FakeMemberSpec {
	readonly id: string;
	readonly role?: 'service' | 'task';
	readonly section?: 'service' | 'package' | 'account' | 'action' | 'app' | 'other';
	readonly deps?: ReadonlyArray<string>;
	readonly watch?: ReadonlyArray<string>;
}

const fakeMember = (spec: FakeMemberSpec): AnyPlugin =>
	({
		id: spec.id,
		role: spec.role ?? 'service',
		section: spec.section ?? 'service',
		dependsOn: (spec.deps ?? []).map((id) => ({ id })),
		...(spec.watch === undefined ? {} : { watch: { paths: spec.watch } }),
	}) as unknown as AnyPlugin;

const fakeStack = (
	members: ReadonlyArray<FakeMemberSpec>,
	options: DevstackOptions = {},
): SupervisedStack => ({
	_tag: 'Stack',
	members: members.map(fakeMember),
	options,
});

const DEVSTACK_VERSION = '1.0.0';

/** Materialize an app tree: write the config file + any `files` map
 *  (relative path → contents) under a fresh appRoot. Returns
 *  `{ appRoot, configPath }`. */
const seedApp = (
	root: string,
	configContents: string,
	files: Readonly<Record<string, string>> = {},
): { readonly appRoot: string; readonly configPath: string } => {
	const appRoot = join(root, 'app');
	mkdirSync(appRoot, { recursive: true });
	const configPath = join(appRoot, 'devstack.config.ts');
	writeFileSync(configPath, configContents);
	for (const [rel, contents] of Object.entries(files)) {
		const abs = join(appRoot, rel);
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, contents);
	}
	return { appRoot, configPath };
};

const fingerprint = (args: {
	readonly stack: SupervisedStack;
	readonly appRoot: string;
	readonly configPath: string;
	readonly devstackVersion?: string;
}): Effect.Effect<string> =>
	computeWarmFingerprint({
		stack: args.stack,
		appRoot: args.appRoot,
		configPath: args.configPath,
		devstackVersion: args.devstackVersion ?? DEVSTACK_VERSION,
	}).pipe(Effect.provide(NodeFileSystem.layer), Effect.orDie);

describe('warm fingerprint', () => {
	it('exposes the baseline snapshot id matching the descriptor pattern', () => {
		expect(WARM_BASELINE_SNAPSHOT_ID).toBe('warm-baseline');
		expect(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(WARM_BASELINE_SNAPSHOT_ID)).toBe(true);
	});

	it.effect('is deterministic across member reordering', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const { appRoot, configPath } = seedApp(root, 'export default {}');
				const a = fakeStack([
					{ id: 'sui' },
					{ id: 'walrus', deps: ['sui'] },
					{ id: 'seal', deps: ['sui', 'walrus'] },
				]);
				const b = fakeStack([
					{ id: 'seal', deps: ['walrus', 'sui'] },
					{ id: 'sui' },
					{ id: 'walrus', deps: ['sui'] },
				]);
				const fa = yield* fingerprint({ stack: a, appRoot, configPath });
				const fb = yield* fingerprint({ stack: b, appRoot, configPath });
				expect(fa).toBe(fb);
				expect(/^[a-f0-9]{64}$/.test(fa)).toBe(true);
			}),
		),
	);

	it.effect('is stable when only the display-only renderer option changes', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const { appRoot, configPath } = seedApp(root, 'export default {}');
				const tui = fakeStack([{ id: 'sui' }], { stackName: 's', renderer: 'tui' });
				const silent = fakeStack([{ id: 'sui' }], { stackName: 's', renderer: 'silent' });
				const fa = yield* fingerprint({ stack: tui, appRoot, configPath });
				const fb = yield* fingerprint({ stack: silent, appRoot, configPath });
				expect(fa).toBe(fb);
			}),
		),
	);

	it.effect('is stable across option-key ordering (canonicalized)', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const { appRoot, configPath } = seedApp(root, 'export default {}');
				const a = fakeStack([{ id: 'sui' }], { stackName: 's', stateDir: '/tmp/x' });
				const b = fakeStack([{ id: 'sui' }], { stateDir: '/tmp/x', stackName: 's' });
				const fa = yield* fingerprint({ stack: a, appRoot, configPath });
				const fb = yield* fingerprint({ stack: b, appRoot, configPath });
				expect(fa).toBe(fb);
			}),
		),
	);

	it.effect('CHANGES when a non-display option changes', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const { appRoot, configPath } = seedApp(root, 'export default {}');
				const a = fakeStack([{ id: 'sui' }], { stackName: 'alpha' });
				const b = fakeStack([{ id: 'sui' }], { stackName: 'beta' });
				const fa = yield* fingerprint({ stack: a, appRoot, configPath });
				const fb = yield* fingerprint({ stack: b, appRoot, configPath });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('CHANGES when the config file bytes change', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const stack = fakeStack([{ id: 'sui' }]);
				const before = seedApp(root, 'export default { network: "localnet" }');
				const fa = yield* fingerprint({ stack, appRoot: before.appRoot, configPath: before.configPath });
				// Rewrite the same config path with different bytes.
				writeFileSync(before.configPath, 'export default { network: "testnet" }');
				const fb = yield* fingerprint({ stack, appRoot: before.appRoot, configPath: before.configPath });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('CHANGES when a watched .move file content changes', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const stack = fakeStack([{ id: 'pkg', watch: ['contracts'] }]);
				const seed = seedApp(root, 'export default {}', {
					'contracts/Move.toml': '[package]\nname = "demo"',
					'contracts/sources/demo.move': 'module demo::a { }',
				});
				const fa = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				// Mutate the .move source content (not its path/mtime).
				writeFileSync(
					join(seed.appRoot, 'contracts/sources/demo.move'),
					'module demo::a { public fun f() {} }',
				);
				const fb = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('CHANGES when a .move file under a GLOB watch path changes', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				// Mirrors `localPackage`'s real watch.paths shape: a `**​/*.move`
				// glob plus a literal `Move.toml`. The glob entry must collapse
				// to its base dir and walk it — `readDirectory` on the raw glob
				// string finds nothing, so this case fails before the fix.
				const stack = fakeStack([
					{ id: 'pkg', watch: ['contracts/**/*.move', 'contracts/Move.toml'] },
				]);
				const seed = seedApp(root, 'export default {}', {
					'contracts/Move.toml': '[package]\nname = "demo"',
					'contracts/sources/demo.move': 'module demo::a { }',
				});
				const fa = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				// Edit ONLY the .move source contents (path/mtime unchanged).
				writeFileSync(
					join(seed.appRoot, 'contracts/sources/demo.move'),
					'module demo::a { public fun f() {} }',
				);
				const fb = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('hashes a literal Move.toml watch path (changes invalidate)', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				// A literal-file watch entry (no glob chars) must be hashed
				// directly — `readDirectory` on a file finds nothing.
				const stack = fakeStack([{ id: 'pkg', watch: ['contracts/Move.toml'] }]);
				const seed = seedApp(root, 'export default {}', {
					'contracts/Move.toml': '[package]\nname = "demo"',
				});
				const fa = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				writeFileSync(
					join(seed.appRoot, 'contracts/Move.toml'),
					'[package]\nname = "demo"\nedition = "2024"',
				);
				const fb = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('ignores non-Move files and missing watch roots under a watch path', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const stack = fakeStack([
					{ id: 'pkg', watch: ['contracts', 'does-not-exist'] },
				]);
				const seed = seedApp(root, 'export default {}', {
					'contracts/sources/demo.move': 'module demo::a { }',
					'contracts/README.md': 'docs',
				});
				const fa = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				// Touching a NON-move file must not move the fingerprint.
				writeFileSync(join(seed.appRoot, 'contracts/README.md'), 'different docs');
				const fb = yield* fingerprint({ stack, appRoot: seed.appRoot, configPath: seed.configPath });
				expect(fa).toBe(fb);
			}),
		),
	);

	it.effect('CHANGES when devstackVersion changes', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const { appRoot, configPath } = seedApp(root, 'export default {}');
				const stack = fakeStack([{ id: 'sui' }]);
				const fa = yield* fingerprint({ stack, appRoot, configPath, devstackVersion: '1.0.0' });
				const fb = yield* fingerprint({ stack, appRoot, configPath, devstackVersion: '1.0.1' });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('CHANGES when the member set changes', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const { appRoot, configPath } = seedApp(root, 'export default {}');
				const a = fakeStack([{ id: 'sui' }]);
				const b = fakeStack([{ id: 'sui' }, { id: 'walrus', deps: ['sui'] }]);
				const fa = yield* fingerprint({ stack: a, appRoot, configPath });
				const fb = yield* fingerprint({ stack: b, appRoot, configPath });
				expect(fa).not.toBe(fb);
			}),
		),
	);

	it.effect('fails with WarmFingerprintError when the config is unreadable', () =>
		withTempRoot('warm-fingerprint', (root) =>
			Effect.gen(function* () {
				const stack = fakeStack([{ id: 'sui' }]);
				const appRoot = join(root, 'app');
				mkdirSync(appRoot, { recursive: true });
				const missingConfig = join(appRoot, 'devstack.config.ts');
				const error = yield* computeWarmFingerprint({
					stack,
					appRoot,
					configPath: missingConfig,
					devstackVersion: DEVSTACK_VERSION,
				}).pipe(Effect.provide(NodeFileSystem.layer), Effect.flip);
				expect(error._tag).toBe('WarmFingerprintError');
				expect(error.path).toBe(missingConfig);
			}),
		),
	);
});
