import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Env } from '../engine/types.js';
import { define } from '../factories/define.js';
import { sui } from '../plugins/sui.js';
import { dep } from '../factories/dep.js';
import { gitFetch, type GitFetchState } from './git-fetch.js';
import { publishMove } from './publish-move.js';

const exec = promisify(execFile);

const gitAvailable = (() => {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

function itGit(name: string, fn: () => Promise<void>, timeout?: number): void {
	if (gitAvailable) {
		it(name, fn, timeout);
	} else {
		it.skip(name, fn);
	}
}

let appDir: string;
let upstreamRepo: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-gitfetch-'));
	upstreamRepo = await mkdtemp(join(tmpdir(), 'devstack-upstream-'));
});

afterEach(async () => {
	await rm(appDir, { recursive: true, force: true });
	await rm(upstreamRepo, { recursive: true, force: true });
});

const baseEnv = (): Env => ({
	appName: 'demo',
	appDir,
	network: 'localnet',
	stack: 'main',
});

// Build a real local git repo with one commit and an optional subdir,
// return its path. Tests use `file://<path>` as the clone URL so no
// network access is needed.
async function makeLocalRepo(opts: {
	files: Record<string, string>;
}): Promise<{ path: string; sha: string }> {
	mkdirSync(upstreamRepo, { recursive: true });
	for (const [rel, content] of Object.entries(opts.files)) {
		const full = join(upstreamRepo, rel);
		mkdirSync(join(full, '..'), { recursive: true });
		await writeFile(full, content, 'utf8');
	}
	await exec('git', ['-C', upstreamRepo, 'init', '-q', '-b', 'main']);
	await exec('git', ['-C', upstreamRepo, 'config', 'user.email', 'test@example.com']);
	await exec('git', ['-C', upstreamRepo, 'config', 'user.name', 'test']);
	await exec('git', ['-C', upstreamRepo, 'config', 'commit.gpgsign', 'false']);
	await exec('git', ['-C', upstreamRepo, 'add', '-A']);
	await exec('git', ['-C', upstreamRepo, 'commit', '-q', '-m', 'init']);
	const { stdout } = await exec('git', ['-C', upstreamRepo, 'rev-parse', 'HEAD']);
	return { path: upstreamRepo, sha: stdout.trim() };
}

describe('gitFetch (validation — no git invocation)', () => {
	it('rejects empty repo', () => {
		expect(() => gitFetch({ repo: '', rev: 'main' })).toThrow(/repo/);
	});

	it('rejects empty rev', () => {
		expect(() => gitFetch({ repo: 'foo/bar', rev: '' })).toThrow(/rev/);
	});
});

describe('gitFetch (real git, file:// URL — no network)', () => {
	itGit(
		'clones at the requested rev and exposes the cache path',
		async () => {
			const { sha } = await makeLocalRepo({
				files: {
					'README.md': 'hello\n',
					'sources/m.move': 'module x::y {}\n',
				},
			});
			const fetched = gitFetch({
				repo: 'local/upstream',
				rev: sha,
				gitUrl: () => `file://${upstreamRepo}`,
			});
			const engine = new Engine({ stack: [fetched] }, { env: baseEnv() });
			const result = await engine.runOnce();
			expect(result.errored).toEqual([]);

			const state = engine.getState().nodes.get(`git.local_upstream@${sha}`)!.state as GitFetchState;
			expect(state.path).toBe(state.cacheDir);
			expect(state.sha).toBe(sha);
			expect(existsSync(join(state.path, 'README.md'))).toBe(true);
			expect(existsSync(join(state.path, 'sources/m.move'))).toBe(true);
		},
		30_000,
	);

	itGit(
		'subdir narrows the path Dep to the requested subtree',
		async () => {
			const { sha } = await makeLocalRepo({
				files: {
					'packages/token/Move.toml': '[package]\nname="token"\n',
					'packages/token/sources/t.move': 'module token::t {}\n',
					'packages/other/Move.toml': '[package]\nname="other"\n',
				},
			});
			const fetched = gitFetch({
				repo: 'local/upstream',
				rev: sha,
				subdir: 'packages/token',
				gitUrl: () => `file://${upstreamRepo}`,
			});
			const engine = new Engine({ stack: [fetched] }, { env: baseEnv() });
			await engine.runOnce();
			const state = engine.getState().nodes.get(`git.local_upstream@${sha}`)!.state as GitFetchState;
			expect(state.path).toBe(join(state.cacheDir, 'packages/token'));
			expect(existsSync(join(state.path, 'Move.toml'))).toBe(true);
			expect(existsSync(join(state.path, 'sources/t.move'))).toBe(true);
		},
		30_000,
	);

	itGit(
		'reuses the cache on warm restart (idempotent on same rev)',
		async () => {
			const { sha } = await makeLocalRepo({ files: { 'a.txt': 'one\n' } });
			const fetched = gitFetch({
				repo: 'local/upstream',
				rev: sha,
				gitUrl: () => `file://${upstreamRepo}`,
			});
			const engine = new Engine({ stack: [fetched] }, { env: baseEnv() });
			await engine.runOnce();
			const first = engine.getState().nodes.get(`git.local_upstream@${sha}`)!.state as GitFetchState;
			// Drop a marker file into the cache. If gitFetch re-clones,
			// the marker disappears.
			await writeFile(join(first.cacheDir, 'marker.txt'), 'still here\n', 'utf8');
			engine.invalidate(`git.local_upstream@${sha}`);
			await engine.runOnce();
			expect(await readFile(join(first.cacheDir, 'marker.txt'), 'utf8')).toBe('still here\n');
		},
		30_000,
	);

	itGit(
		'errors when the requested subdir does not exist',
		async () => {
			const { sha } = await makeLocalRepo({ files: { 'README.md': 'x\n' } });
			const fetched = gitFetch({
				repo: 'local/upstream',
				rev: sha,
				subdir: 'no/such/dir',
				gitUrl: () => `file://${upstreamRepo}`,
			});
			const engine = new Engine({ stack: [fetched] }, { env: baseEnv() });
			const result = await engine.runOnce();
			expect(result.errored).toHaveLength(1);
			expect(result.errored[0]?.error.message).toMatch(/subdir/);
		},
		30_000,
	);

	itGit(
		'composes with publishMove via the path Dep',
		async () => {
			// Real-world chain: gitFetch produces a path → publishMove
			// reads it and runs the user's publish callback. We don't
			// actually publish on-chain (tests can't reach a real RPC);
			// just verify the path resolves correctly through the dep
			// system and the publish callback receives the right
			// `sourcePath`.
			const { sha } = await makeLocalRepo({
				files: {
					'Move.toml': '[package]\nname = "demo"\n',
					'sources/m.move': 'module demo::m {}\n',
				},
			});
			const fetched = gitFetch({
				repo: 'local/upstream',
				rev: sha,
				gitUrl: () => `file://${upstreamRepo}`,
			});
			const acc = define({
				name: 'acc.publisher',
				provides: { signer: dep((s: { addr: string }) => s) },
				start: async () => ({ addr: '0x1' }),
			});
			let receivedSourcePath: string | undefined;
			const pub = publishMove({
				name: 'demo',
				path: fetched.get('path'),
				signer: acc.get('signer'),
				publish: async ({ sourcePath }) => {
					receivedSourcePath = sourcePath;
					return { packageId: '0xpkg' };
				},
			});
			const engine = new Engine(
				{ stack: [sui.create({ network: 'testnet' }), fetched, acc, pub] },
				{ env: baseEnv() },
			);
			const result = await engine.runOnce();
			if (result.errored.length > 0) throw result.errored[0]?.error;
			expect(receivedSourcePath).toBeDefined();
			// The path the publish callback saw should match what gitFetch wrote.
			const fetchedState = engine.getState().nodes.get(`git.local_upstream@${sha}`)!
				.state as GitFetchState;
			expect(receivedSourcePath).toBe(fetchedState.path);
		},
		30_000,
	);
});
