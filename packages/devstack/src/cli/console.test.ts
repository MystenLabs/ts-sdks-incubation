// Console package-bindings loader tests. The hands-on review found the
// REPL's `packages.<name>` was empty on every fresh app — codegen emits
// `<output>/<pkg>/<module>.ts` (one file per Move module) but the loader
// looked for `<output>/<pkg>/<pkg>.ts` (legacy assumption). Plus
// codegen's `.js` import specifiers wouldn't resolve under plain Node
// `await import()`. These tests pin the new contract:
//
//   - Walk every `.ts` file under `<output>/<pkg>/`, merge named exports.
//   - Auto-default `package:` to the live `packageId` for the call-site
//     ergonomic that's the whole point of the REPL.
//
// Codegen now emits `.ts` import specifiers and Node 24 strips types
// from `.ts` files natively, so the loader is plain `await import()`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Manifest } from '../runtime/manifest-types.js';
import { loadPackageBindings, wrapWithDefaultPackage } from './console.js';

let appDirs: string[] = [];

function newAppDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-console-'));
	appDirs.push(dir);
	return dir;
}

function writeCodegen(
	appDir: string,
	codegenDir: string,
	pkg: string,
	files: Record<string, string>,
): void {
	const dir = resolve(appDir, codegenDir, pkg);
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(dir, name), body);
	}
}

function manifestWith(packages: Array<{ name: string; packageId: string }>): Manifest {
	return {
		app: 'fixture',
		network: 'localnet',
		emittedAt: new Date().toISOString(),
		registry: {
			tokens: [],
			packages: packages.map((p) => ({
				name: p.name,
				packageId: p.packageId,
				captured: {},
				network: 'localnet',
			})),
			accounts: [],
			services: [],
		},
	};
}

beforeEach(() => {
	appDirs = [];
});

afterEach(() => {
	for (const d of appDirs) rmSync(d, { recursive: true, force: true });
});

describe('loadPackageBindings — directory walk', () => {
	it('returns empty when codegen dir does not exist', async () => {
		const appDir = newAppDir();
		const out = await loadPackageBindings({
			appDir,
			manifest: manifestWith([{ name: 'pkg', packageId: '0xpkg' }]),
			codegenDir: 'src/generated/sui',
		});
		expect(out).toEqual({});
	});

	it('returns empty when the package subdir is missing', async () => {
		const appDir = newAppDir();
		mkdirSync(resolve(appDir, 'src/generated/sui'), { recursive: true });
		const out = await loadPackageBindings({
			appDir,
			manifest: manifestWith([{ name: 'pkg', packageId: '0xpkg' }]),
			codegenDir: 'src/generated/sui',
		});
		expect(out).toEqual({});
	});

	it('loads exports from the per-package <module>.ts files', async () => {
		const appDir = newAppDir();
		writeCodegen(appDir, 'src/generated/sui', 'connect_four', {
			'game.ts': `export const PACKAGE_NAME = 'connect_four';\nexport function joinLobby(opts) { return { call: 'join', opts }; }\n`,
			'lobby.ts': `export function createLobby(opts) { return { call: 'create', opts }; }\n`,
		});
		const out = await loadPackageBindings({
			appDir,
			manifest: manifestWith([{ name: 'connect_four', packageId: '0xpkg123' }]),
			codegenDir: 'src/generated/sui',
		});
		expect(Object.keys(out)).toEqual(['connect_four']);
		const bindings = out.connect_four as Record<string, unknown>;
		expect(typeof bindings.joinLobby).toBe('function');
		expect(typeof bindings.createLobby).toBe('function');
		expect(bindings.PACKAGE_NAME).toBe('connect_four');
		expect(bindings.$id).toBe('0xpkg123');
	});

	it('skips .d.ts files', async () => {
		const appDir = newAppDir();
		writeCodegen(appDir, 'src/generated/sui', 'pkg', {
			'mod.ts': `export const X = 'real';\n`,
			'mod.d.ts': `export declare const Y: string;\n`,
		});
		const out = await loadPackageBindings({
			appDir,
			manifest: manifestWith([{ name: 'pkg', packageId: '0xpkg' }]),
			codegenDir: 'src/generated/sui',
		});
		const bindings = out.pkg as Record<string, unknown>;
		expect(bindings.X).toBe('real');
		expect(bindings.Y).toBeUndefined();
	});

	it('continues past per-file import errors with a stderr warning', async () => {
		const appDir = newAppDir();
		writeCodegen(appDir, 'src/generated/sui', 'pkg', {
			'good.ts': `export const OK = true;\n`,
			'bad.ts': `import { nope } from './does-not-exist.ts';\nexport const X = nope;\n`,
		});
		const stderrLines: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((line: string) => {
			stderrLines.push(line);
			return true;
		}) as typeof process.stderr.write;
		try {
			const out = await loadPackageBindings({
				appDir,
				manifest: manifestWith([{ name: 'pkg', packageId: '0xpkg' }]),
				codegenDir: 'src/generated/sui',
			});
			expect((out.pkg as { OK: boolean }).OK).toBe(true);
			expect(stderrLines.some((l) => l.includes('bad.ts'))).toBe(true);
		} finally {
			process.stderr.write = orig;
		}
	});

	it('honors absolute codegen paths', async () => {
		const appDir = newAppDir();
		const absoluteOutput = resolve(appDir, 'custom/codegen');
		writeCodegen(appDir, 'custom/codegen', 'pkg', {
			'mod.ts': `export const Y = 42;\n`,
		});
		const out = await loadPackageBindings({
			appDir,
			manifest: manifestWith([{ name: 'pkg', packageId: '0xabc' }]),
			codegenDir: absoluteOutput,
		});
		expect((out.pkg as { Y: number }).Y).toBe(42);
	});

	it('multiple packages → multiple top-level keys', async () => {
		const appDir = newAppDir();
		writeCodegen(appDir, 'src/generated/sui', 'a', { 'a.ts': `export const id = 'a';\n` });
		writeCodegen(appDir, 'src/generated/sui', 'b', { 'b.ts': `export const id = 'b';\n` });
		const out = await loadPackageBindings({
			appDir,
			manifest: manifestWith([
				{ name: 'a', packageId: '0xa' },
				{ name: 'b', packageId: '0xb' },
			]),
			codegenDir: 'src/generated/sui',
		});
		expect(Object.keys(out).sort()).toEqual(['a', 'b']);
		expect((out.a as { $id: string }).$id).toBe('0xa');
		expect((out.b as { $id: string }).$id).toBe('0xb');
	});
});

describe('wrapWithDefaultPackage', () => {
	it('threads `package: <packageId>` into function calls when caller omits it', () => {
		const inner = (opts: Record<string, unknown>) => opts;
		const wrapped = wrapWithDefaultPackage({ fn: inner }, '0xlive') as Record<
			string,
			unknown
		>;
		const call = wrapped.fn as (opts?: Record<string, unknown>) => Record<string, unknown>;
		expect(call({ arguments: [1, 2] })).toEqual({ arguments: [1, 2], package: '0xlive' });
		// Caller's explicit `package:` wins over the default.
		expect(call({ package: '0xother' })).toEqual({ package: '0xother' });
	});

	it('passes non-function exports through verbatim', () => {
		const wrapped = wrapWithDefaultPackage(
			{ CONST: 7, type: { kind: 'struct' } },
			'0xpkg',
		) as Record<string, unknown>;
		expect(wrapped.CONST).toBe(7);
		expect(wrapped.type).toEqual({ kind: 'struct' });
		expect(wrapped.$id).toBe('0xpkg');
	});

	it('drops `default` exports (REPL doesn`t need them)', () => {
		const wrapped = wrapWithDefaultPackage(
			{ default: 'should-be-dropped', X: 'kept' },
			'0xpkg',
		) as Record<string, unknown>;
		expect(wrapped.default).toBeUndefined();
		expect(wrapped.X).toBe('kept');
	});
});
