import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env, SnapshotRecord } from '../engine/types.js';
import {
	labeledSnapshotPath,
	labeledSnapshotsDir,
	snapshotPathFor,
} from './paths.js';
import { tryReadSnapshot } from './read.js';
import { writeJsonAtomic, writeSnapshot } from './write.js';

let appDir: string;

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), 'devstack-next-persist-'));
});

afterEach(async () => {
	await import('node:fs/promises').then((m) => m.rm(appDir, { recursive: true, force: true }));
});

function localEnv(stack?: string): Env {
	const env: Env = { appName: 'demo', appDir, network: 'localnet' };
	if (stack !== undefined) env.stack = stack;
	return env;
}

function liveEnv(network: string): Env {
	return { appName: 'demo', appDir, network };
}

function sampleRecord(env: Env): SnapshotRecord {
	const recordEnv: SnapshotRecord['env'] = { appName: env.appName, network: env.network };
	if (env.stack !== undefined) recordEnv.stack = env.stack;
	return {
		createdAt: 1_700_000_000_000,
		env: recordEnv,
		nodeStates: {
			'sui.localnet': {
				lastInputHash: 'abc',
				lastRunAt: 1_700_000_000_000,
				identity: 'id1',
				state: { rpcUrl: 'http://localhost:9000' },
			},
		},
		meta: { devstackVersion: '0.0.0-dev' },
	};
}

describe('snapshotPathFor', () => {
	it('localnet → stacks/<stack>/snapshot.json', () => {
		expect(snapshotPathFor(localEnv('main'))).toBe(
			join(appDir, '.devstack/stacks/main/snapshot.json'),
		);
		expect(snapshotPathFor(localEnv('test'))).toBe(
			join(appDir, '.devstack/stacks/test/snapshot.json'),
		);
	});

	it('localnet defaults to stack=main when env.stack is unset', () => {
		expect(snapshotPathFor(localEnv())).toBe(
			join(appDir, '.devstack/stacks/main/snapshot.json'),
		);
	});

	it('live nets → networks/<network>.json (no stack dimension)', () => {
		expect(snapshotPathFor(liveEnv('testnet'))).toBe(
			join(appDir, '.devstack/networks/testnet.json'),
		);
		expect(snapshotPathFor(liveEnv('mainnet'))).toBe(
			join(appDir, '.devstack/networks/mainnet.json'),
		);
	});
});

describe('labeled snapshots', () => {
	it('labeledSnapshotsDir is localnet-only', () => {
		expect(labeledSnapshotsDir(localEnv('main'))).toBe(
			join(appDir, '.devstack/stacks/main/snapshots'),
		);
		expect(() => labeledSnapshotsDir(liveEnv('testnet'))).toThrow(/localnet/);
	});

	it('labeledSnapshotPath includes label suffix when provided', () => {
		expect(labeledSnapshotPath(localEnv('main'), '01HXY', 'before-publish')).toBe(
			join(appDir, '.devstack/stacks/main/snapshots/01HXY-before-publish.json'),
		);
		expect(labeledSnapshotPath(localEnv('main'), '01HXY')).toBe(
			join(appDir, '.devstack/stacks/main/snapshots/01HXY.json'),
		);
	});
});

describe('tryReadSnapshot', () => {
	it('returns undefined when no file exists (cold start)', async () => {
		expect(await tryReadSnapshot(localEnv('main'))).toBeUndefined();
	});

	it('reads back what writeSnapshot wrote', async () => {
		const env = localEnv('main');
		const record = sampleRecord(env);
		await writeSnapshot(env, record);
		const read = await tryReadSnapshot(env);
		expect(read).toEqual(record);
	});

	it('throws on malformed JSON (loud failure, not silent reset)', async () => {
		const env = localEnv('main');
		const path = snapshotPathFor(env);
		await import('node:fs/promises').then((m) => m.mkdir(join(path, '..'), { recursive: true }));
		await writeFile(path, '{not json', 'utf8');
		await expect(tryReadSnapshot(env)).rejects.toThrow(/failed to parse/);
	});

	it('throws on JSON missing required fields', async () => {
		const env = localEnv('main');
		const path = snapshotPathFor(env);
		await import('node:fs/promises').then((m) => m.mkdir(join(path, '..'), { recursive: true }));
		await writeFile(path, JSON.stringify({ createdAt: 'no' }), 'utf8');
		await expect(tryReadSnapshot(env)).rejects.toThrow(/missing required fields/);
	});
});

describe('writeSnapshot', () => {
	it('creates parent directories as needed', async () => {
		const env = localEnv('fresh-stack');
		await writeSnapshot(env, sampleRecord(env));
		const body = await readFile(
			join(appDir, '.devstack/stacks/fresh-stack/snapshot.json'),
			'utf8',
		);
		expect(JSON.parse(body)).toEqual(sampleRecord(env));
	});

	it('writes pretty JSON for human inspection', async () => {
		const env = localEnv('main');
		await writeSnapshot(env, sampleRecord(env));
		const body = await readFile(snapshotPathFor(env), 'utf8');
		expect(body.includes('\n')).toBe(true);
		expect(body.includes('  ')).toBe(true);
	});

	it('overwrites prior snapshot atomically (no temp file lingers)', async () => {
		const env = localEnv('main');
		await writeSnapshot(env, sampleRecord(env));
		const next = { ...sampleRecord(env), createdAt: 1_800_000_000_000 };
		await writeSnapshot(env, next);
		const read = await tryReadSnapshot(env);
		expect(read?.createdAt).toBe(1_800_000_000_000);
		const dirEntries = await import('node:fs/promises').then((m) =>
			m.readdir(join(appDir, '.devstack/stacks/main')),
		);
		expect(dirEntries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
	});
});

describe('writeJsonAtomic (general helper)', () => {
	it('writes arbitrary JSON to an arbitrary path', async () => {
		const target = join(appDir, 'arbitrary/nested/path/value.json');
		await writeJsonAtomic(target, { hello: 'world', n: 7 });
		const body = await readFile(target, 'utf8');
		expect(JSON.parse(body)).toEqual({ hello: 'world', n: 7 });
	});
});
