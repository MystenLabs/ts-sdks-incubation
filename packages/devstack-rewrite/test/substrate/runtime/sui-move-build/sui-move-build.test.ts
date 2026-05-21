import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	hashMoveSources,
	parseBuildOutput,
	stripPinnedSections,
} from '../../../../src/substrate/runtime/sui-move-build/index.ts';

describe('sui-move-build helpers', () => {
	it('strips pinned Move.lock sections idempotently', () => {
		const input = [
			'[move]',
			'version = 3',
			'',
			'[pinned.testnet.dep]',
			'published-at = "0x1"',
			'',
			'[env]',
			'chain-id = "old"',
			'',
			'[dependencies]',
			'Foo = "local"',
			'',
		].join('\n');
		const stripped = stripPinnedSections(input);
		expect(stripped).toContain('[move]');
		expect(stripped).toContain('[dependencies]');
		expect(stripped).not.toContain('[pinned.testnet.dep]');
		expect(stripped).not.toContain('[env]');
		expect(stripPinnedSections(stripped)).toBe(stripped);
	});

	it('hashes Move sources while normalising Move.lock pinned drift', async () => {
		const root = await mkdtemp(join(tmpdir(), 'devstack-move-build-'));
		try {
			await mkdir(join(root, 'sources'), { recursive: true });
			await mkdir(join(root, 'build'), { recursive: true });
			await writeFile(join(root, 'Move.toml'), '[package]\nname = "demo"\n');
			await writeFile(join(root, 'sources', 'demo.move'), 'module demo::demo {}\n');
			await writeFile(join(root, 'build', 'ignored.move'), 'module ignored::ignored {}\n');
			await writeFile(
				join(root, 'Move.lock'),
				'[move]\nversion = 3\n[pinned.testnet.dep]\npublished-at = "0x1"\n',
			);

			const first = await Effect.runPromise(hashMoveSources(root));
			await writeFile(
				join(root, 'Move.lock'),
				'[move]\nversion = 3\n[pinned.testnet.dep]\npublished-at = "0x2"\n',
			);
			const second = await Effect.runPromise(hashMoveSources(root));
			expect(second).toBe(first);

			await writeFile(
				join(root, 'sources', 'demo.move'),
				'module demo::demo { fun changed() {} }\n',
			);
			const third = await Effect.runPromise(hashMoveSources(root));
			expect(third).not.toBe(first);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('parses trailing sui move build JSON into bytecode modules', async () => {
		const output = [
			'Compiling dependencies...',
			JSON.stringify({
				modules: [Buffer.from([1, 2, 3]).toString('base64')],
				dependencies: ['0x1', '0x2'],
			}),
		].join('\n');

		const parsed = await Effect.runPromise(parseBuildOutput(output, '/tmp/demo', 'demo'));
		expect(parsed.modules).toEqual([new Uint8Array([1, 2, 3])]);
		expect(parsed.dependencies).toEqual(['0x1', '0x2']);
	});
});
