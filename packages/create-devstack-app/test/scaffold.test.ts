// Scaffolds into mkdtemp dirs with install/git skipped, asserting the
// template CONTRACT (files both templates are guaranteed to carry) rather
// than exhaustive trees: package.json + _gitignore rename + the rendered
// devstack.config.ts, dep selection, SDK version injection, and refusals.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderDevstackConfig } from '../src/render-config.js';
import { resolveSdkVersions, scaffold } from '../src/scaffold.js';
import { parseServiceList, SERVICES, type ServiceId } from '../src/services.js';

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'create-devstack-app-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface PackageJson {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function readPackageJson(appDir: string): { raw: string; json: PackageJson } {
	const raw = readFileSync(join(appDir, 'package.json'), 'utf8');
	return { raw, json: JSON.parse(raw) as PackageJson };
}

/** dependencies + devDependencies merged — service deps may live in either. */
function allDeps(json: PackageJson): Record<string, string> {
	return { ...json.dependencies, ...json.devDependencies };
}

async function run(opts: {
	name?: string;
	template: 'app' | 'ts';
	services: ReadonlyArray<ServiceId>;
	targetDir?: string;
}) {
	const targetDir = opts.targetDir ?? tempDir();
	const result = await scaffold({
		name: opts.name ?? 'my-app',
		targetDir,
		template: opts.template,
		services: opts.services,
		skipInstall: true,
		skipGit: true,
		log: () => {},
	});
	return { targetDir, result };
}

describe('scaffold', () => {
	it('scaffolds the ts template: contract files, _gitignore rename, rendered config', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { targetDir, result } = await run({ template: 'ts', services: [] });
		const appDir = join(targetDir, 'my-app');
		expect(result.appDir).toBe(appDir);
		expect(result.installed).toBe(false);
		expect(result.gitInitialized).toBe(false);

		for (const file of [
			'package.json',
			'.gitignore',
			'devstack.config.ts',
			'move/counter/Move.toml',
			'src/counter.ts',
			'vitest.config.ts',
		]) {
			expect(existsSync(join(appDir, file)), `${file} should exist`).toBe(true);
		}
		expect(existsSync(join(appDir, '_gitignore'))).toBe(false);

		expect(readFileSync(join(appDir, 'devstack.config.ts'), 'utf8')).toBe(
			renderDevstackConfig('ts', new Set()),
		);
	});

	it('scaffolds the app template with its frontend contract files', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { targetDir } = await run({ template: 'app', services: ['walrus', 'seal'] });
		const appDir = join(targetDir, 'my-app');

		for (const file of ['index.html', 'vite.config.ts', 'src/App.tsx']) {
			expect(existsSync(join(appDir, file)), `${file} should exist`).toBe(true);
		}
		expect(readFileSync(join(appDir, 'devstack.config.ts'), 'utf8')).toBe(
			renderDevstackConfig('app', new Set(['walrus', 'seal'])),
		);
	});

	it('patches package.json: name set, tab-indented, trailing newline', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { targetDir } = await run({ name: 'patched-app', template: 'ts', services: [] });
		const { raw, json } = readPackageJson(join(targetDir, 'patched-app'));
		expect(json.name).toBe('patched-app');
		expect(raw.startsWith('{\n\t"')).toBe(true);
		expect(raw.endsWith('}\n')).toBe(true);
	});

	it('keeps selected services’ deps and deletes unselected ones', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { targetDir } = await run({ template: 'app', services: ['walrus'] });
		const deps = allDeps(readPackageJson(join(targetDir, 'my-app')).json);

		for (const dep of SERVICES.walrus.deps) {
			expect(deps[dep], `${dep} should be kept`).toBeDefined();
		}
		for (const dep of SERVICES.seal.deps) {
			expect(deps[dep], `${dep} should be removed`).toBeUndefined();
		}
	});

	it('warns about workspace SDK specs (dev checkout) and keeps template versions', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { targetDir } = await run({ template: 'ts', services: [] });
		// In this dev checkout the scaffolder's own SDK devDependencies are
		// `workspace:^` — injection must fall back to the template's pinned
		// versions and say so.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace'));

		const deps = allDeps(readPackageJson(join(targetDir, 'my-app')).json);
		const devstackSpec = deps['@mysten-incubation/devstack'];
		expect(devstackSpec).toBeDefined();
		expect(devstackSpec!.startsWith('workspace:')).toBe(false);
	});

	it('refuses an existing non-empty target dir, allows an empty one', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const targetDir = tempDir();
		const appDir = join(targetDir, 'my-app');
		mkdirSync(appDir, { recursive: true });
		writeFileSync(join(appDir, 'keep.txt'), 'x');
		await expect(run({ template: 'ts', services: [], targetDir })).rejects.toThrow(
			/already exists and is not empty/,
		);

		const emptyTarget = tempDir();
		mkdirSync(join(emptyTarget, 'my-app'), { recursive: true });
		await expect(
			run({ template: 'ts', services: [], targetDir: emptyTarget }),
		).resolves.toBeDefined();
	});

	it('rejects invalid app names', async () => {
		await expect(run({ name: 'My_App', template: 'ts', services: [] })).rejects.toThrow(
			/invalid app name/,
		);
	});
});

describe('resolveSdkVersions', () => {
	it('returns publish-time specs verbatim without warning', () => {
		const warn = vi.fn();
		const versions = resolveSdkVersions(
			{
				devDependencies: {
					'@mysten-incubation/devstack': '^0.2.0',
					'@mysten-incubation/dev-wallet': '^0.4.0',
				},
			},
			warn,
		);
		expect(versions.get('@mysten-incubation/devstack')).toBe('^0.2.0');
		expect(versions.get('@mysten-incubation/dev-wallet')).toBe('^0.4.0');
		expect(warn).not.toHaveBeenCalled();
	});

	it('skips workspace specs with a warning naming the packages', () => {
		const warn = vi.fn();
		const versions = resolveSdkVersions(
			{
				devDependencies: {
					'@mysten-incubation/devstack': 'workspace:^',
					'@mysten-incubation/dev-wallet': '^0.4.0',
				},
			},
			warn,
		);
		expect(versions.has('@mysten-incubation/devstack')).toBe(false);
		expect(versions.get('@mysten-incubation/dev-wallet')).toBe('^0.4.0');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('@mysten-incubation/devstack'));
	});

	it('silently skips SDK packages absent from the manifest', () => {
		const warn = vi.fn();
		expect(resolveSdkVersions({}, warn).size).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe('parseServiceList', () => {
	it('parses, dedupes, and normalizes to canonical order', () => {
		expect(parseServiceList('seal,walrus,walrus')).toEqual(['walrus', 'seal']);
		expect(parseServiceList('seal')).toEqual(['seal']);
		expect(parseServiceList('walrus, seal ')).toEqual(['walrus', 'seal']);
	});

	it('treats empty input as no services', () => {
		expect(parseServiceList('')).toEqual([]);
		expect(parseServiceList(',')).toEqual([]);
	});

	it('throws a usage-style error on unknown services', () => {
		expect(() => parseServiceList('walrus,postgres')).toThrow(
			"unknown service 'postgres'. Valid: walrus, seal.",
		);
	});
});
