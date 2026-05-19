// Workspace-aware config discovery — `findConfigUp` walks up from a
// starting cwd looking for `devstack.config.{ts,js,mjs}` and stops at
// the first `package.json` encountered. The package boundary is the
// workspace boundary; without that guard a sibling app's root config
// could shadow a subdir's intent.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoadError } from '../engine/errors.js';
import { findConfigUp, requireLaunchEffect, requireLayer } from './loaders.js';

const fixture = (): string => mkdtempSync(join(tmpdir(), 'devstack-loaders-'));

describe('findConfigUp', () => {
	it('finds a config in the same dir', () => {
		const root = fixture();
		mkdirSync(join(root, 'pkg'), { recursive: true });
		writeFileSync(join(root, 'pkg', 'package.json'), '{"name":"pkg"}');
		writeFileSync(join(root, 'pkg', 'devstack.config.ts'), 'export default {}');
		const found = findConfigUp(join(root, 'pkg'));
		expect(found).toBe(join(root, 'pkg', 'devstack.config.ts'));
	});

	it('walks up two dirs to find a config under the same package', () => {
		// Layout:
		//   pkg/                <- package.json + devstack.config.ts
		//     subA/
		//       subB/           <- caller's cwd
		const root = fixture();
		mkdirSync(join(root, 'pkg', 'subA', 'subB'), { recursive: true });
		writeFileSync(join(root, 'pkg', 'package.json'), '{"name":"pkg"}');
		writeFileSync(join(root, 'pkg', 'devstack.config.ts'), 'export default {}');
		const found = findConfigUp(join(root, 'pkg', 'subA', 'subB'));
		expect(found).toBe(join(root, 'pkg', 'devstack.config.ts'));
	});

	it('returns null when no config is reachable below the package boundary', () => {
		// Layout:
		//   workspace/           <- has devstack.config.ts (must NOT match)
		//     pkg/               <- package.json (the boundary)
		//       subA/            <- caller's cwd
		// The package's own boundary blocks the walk-up; the workspace-
		// root config is intentionally NOT picked up.
		const root = fixture();
		mkdirSync(join(root, 'pkg', 'subA'), { recursive: true });
		writeFileSync(join(root, 'devstack.config.ts'), 'export default {}');
		writeFileSync(join(root, 'pkg', 'package.json'), '{"name":"pkg"}');
		const found = findConfigUp(join(root, 'pkg', 'subA'));
		expect(found).toBeNull();
	});

	it('returns null when no config exists in any ancestor at all', () => {
		const root = fixture();
		mkdirSync(join(root, 'pkg', 'subA'), { recursive: true });
		writeFileSync(join(root, 'pkg', 'package.json'), '{"name":"pkg"}');
		const found = findConfigUp(join(root, 'pkg', 'subA'));
		expect(found).toBeNull();
	});

	it('accepts .mts / .mjs / .js as alternative extensions', () => {
		const root = fixture();
		mkdirSync(join(root, 'a'), { recursive: true });
		mkdirSync(join(root, 'b'), { recursive: true });
		mkdirSync(join(root, 'c'), { recursive: true });
		writeFileSync(join(root, 'a', 'package.json'), '{}');
		writeFileSync(join(root, 'a', 'devstack.config.mts'), '');
		writeFileSync(join(root, 'b', 'package.json'), '{}');
		writeFileSync(join(root, 'b', 'devstack.config.mjs'), '');
		writeFileSync(join(root, 'c', 'package.json'), '{}');
		writeFileSync(join(root, 'c', 'devstack.config.js'), '');
		expect(findConfigUp(join(root, 'a'))).toBe(join(root, 'a', 'devstack.config.mts'));
		expect(findConfigUp(join(root, 'b'))).toBe(join(root, 'b', 'devstack.config.mjs'));
		expect(findConfigUp(join(root, 'c'))).toBe(join(root, 'c', 'devstack.config.js'));
	});
});

describe('requireLaunchEffect / requireLayer typed-throws', () => {
	const CONFIG_PATH = '/abs/path/to/devstack.config.ts';

	it('requireLaunchEffect throws ConfigLoadError when module has no default export', () => {
		try {
			requireLaunchEffect(CONFIG_PATH, {});
			throw new Error('expected requireLaunchEffect to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigLoadError);
			const typed = err as ConfigLoadError;
			expect(typed._tag).toBe('ConfigLoadError');
			expect(typed.phase).toBe('validate');
			expect(typed.configPath).toBe(CONFIG_PATH);
		}
	});

	it('requireLaunchEffect throws ConfigLoadError when default export lacks launchEffect', () => {
		try {
			requireLaunchEffect(CONFIG_PATH, { default: { layer: {} } });
			throw new Error('expected requireLaunchEffect to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigLoadError);
			expect((err as ConfigLoadError).phase).toBe('validate');
		}
	});

	it('requireLayer throws ConfigLoadError when default export lacks layer', () => {
		try {
			requireLayer(CONFIG_PATH, { default: {} });
			throw new Error('expected requireLayer to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigLoadError);
			const typed = err as ConfigLoadError;
			expect(typed._tag).toBe('ConfigLoadError');
			expect(typed.phase).toBe('validate');
		}
	});
});
