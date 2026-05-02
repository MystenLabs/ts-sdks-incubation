import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInMemoryPortAllocator, createPortAllocator } from './port-allocator.js';

function withTempAppDir<T>(fn: (appDir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), 'devstack-port-test-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('createInMemoryPortAllocator', () => {
	it('returns a single port for count=1', async () => {
		const alloc = createInMemoryPortAllocator({ startAt: 30000 });
		const ports = await alloc.allocate({ slot: 'sui.rpc' });
		expect(ports).toEqual([30000]);
	});

	it('is idempotent — same slot returns the same ports', async () => {
		const alloc = createInMemoryPortAllocator({ startAt: 30000 });
		const a = await alloc.allocate({ slot: 'sui.rpc' });
		const b = await alloc.allocate({ slot: 'sui.rpc' });
		expect(a).toEqual(b);
	});

	it('honors preferred when slot is fresh', async () => {
		const alloc = createInMemoryPortAllocator({ startAt: 30000 });
		const ports = await alloc.allocate({ slot: 'sui.rpc', preferred: 9000 });
		expect(ports).toEqual([9000]);
	});

	it('allocates a contiguous range for count>1', async () => {
		const alloc = createInMemoryPortAllocator({ startAt: 19185 });
		const ports = await alloc.allocate({ slot: 'walrus.node', count: 4 });
		expect(ports).toEqual([19185, 19186, 19187, 19188]);
	});

	it('different slots get different ports', async () => {
		const alloc = createInMemoryPortAllocator({ startAt: 30000 });
		const rpc = await alloc.allocate({ slot: 'sui.rpc' });
		const faucet = await alloc.allocate({ slot: 'sui.faucet' });
		expect(rpc[0]).not.toBe(faucet[0]);
	});

	it('rejects count<1', async () => {
		const alloc = createInMemoryPortAllocator();
		await expect(alloc.allocate({ slot: 'x', count: 0 })).rejects.toThrow(/count must be >= 1/);
	});
});

describe('createPortAllocator (disk-backed)', () => {
	it('persists allocations to <stackDir>/ports.json', async () => {
		await withTempAppDir(async (appDir) => {
			const alloc = createPortAllocator({ appDir, stack: 'main' });
			await alloc.allocate({ slot: 'sui.rpc', preferred: 30001 });
			const path = resolve(appDir, '.devstack', 'stacks', 'main', 'ports.json');
			expect(existsSync(path)).toBe(true);
			const file = JSON.parse(readFileSync(path, 'utf8'));
			expect(file).toEqual({ 'sui.rpc': 30001 });
		});
	});

	it('survives across allocator instances (re-reads the file)', async () => {
		await withTempAppDir(async (appDir) => {
			const a = createPortAllocator({ appDir, stack: 'main' });
			await a.allocate({ slot: 'sui.rpc', preferred: 30002 });
			const b = createPortAllocator({ appDir, stack: 'main' });
			const ports = await b.allocate({ slot: 'sui.rpc' });
			expect(ports).toEqual([30002]);
		});
	});

	it('isolates by stack — main and test get independent files', async () => {
		await withTempAppDir(async (appDir) => {
			const main = createPortAllocator({ appDir, stack: 'main' });
			const test = createPortAllocator({ appDir, stack: 'test' });
			await main.allocate({ slot: 'sui.rpc', preferred: 30003 });
			await test.allocate({ slot: 'sui.rpc', preferred: 30004 });
			const mainFile = JSON.parse(
				readFileSync(resolve(appDir, '.devstack/stacks/main/ports.json'), 'utf8'),
			);
			const testFile = JSON.parse(
				readFileSync(resolve(appDir, '.devstack/stacks/test/ports.json'), 'utf8'),
			);
			expect(mainFile['sui.rpc']).toBe(30003);
			expect(testFile['sui.rpc']).toBe(30004);
		});
	});

	it('writes contiguous ranges as arrays', async () => {
		await withTempAppDir(async (appDir) => {
			const alloc = createPortAllocator({ appDir, stack: 'main' });
			await alloc.allocate({ slot: 'walrus.node', count: 4, preferred: 19185 });
			const file = JSON.parse(
				readFileSync(resolve(appDir, '.devstack/stacks/main/ports.json'), 'utf8'),
			);
			expect(file['walrus.node']).toEqual([19185, 19186, 19187, 19188]);
		});
	});

	it('throws when count changes for an existing slot', async () => {
		await withTempAppDir(async (appDir) => {
			const a = createPortAllocator({ appDir, stack: 'main' });
			await a.allocate({ slot: 'walrus.node', count: 4, preferred: 19185 });
			const b = createPortAllocator({ appDir, stack: 'main' });
			await expect(b.allocate({ slot: 'walrus.node', count: 2 })).rejects.toThrow(
				/previously allocated 4 ports but now requests 2/,
			);
		});
	});

	it('falls back to a kernel-chosen port when preferred is taken', async () => {
		await withTempAppDir(async (appDir) => {
			const a = createPortAllocator({ appDir, stack: 'main' });
			const first = await a.allocate({ slot: 'sui.rpc', preferred: 30005 });
			expect(first).toEqual([30005]);
			// Same preferred for a different slot — taken via the in-memory
			// `taken` set; should fall back to a kernel port.
			const second = await a.allocate({ slot: 'sui.faucet', preferred: 30005 });
			expect(second[0]).not.toBe(30005);
			expect(typeof second[0]).toBe('number');
		});
	});

	it('avoids ports claimed by sibling stacks of the same app', async () => {
		await withTempAppDir(async (appDir) => {
			const main = createPortAllocator({ appDir, stack: 'main' });
			await main.allocate({ slot: 'sui.rpc', preferred: 30006 });
			// Test stack constructed AFTER main has persisted; should see
			// 30006 as taken even though it's not in test's own ports.json.
			const test = createPortAllocator({ appDir, stack: 'test' });
			const result = await test.allocate({ slot: 'sui.rpc', preferred: 30006 });
			expect(result[0]).not.toBe(30006);
			expect(typeof result[0]).toBe('number');
		});
	});
});
