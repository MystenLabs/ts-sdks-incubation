// Per-stack dynamic port allocation. Plugins request named slots; the
// allocator returns concrete ports that are stable for the stack's
// lifetime. Allocations persist to `<stackDir>/ports.json` so:
//
//   1. The same `devstack up` cycle resolves the same port across
//      multiple `getStatus`/`run` calls (idempotent).
//   2. Snapshot capture rolls them into the host bundle (since
//      <stackDir> is what we copy); restore brings the same
//      assignments back so the manifest's URLs stay valid.
//   3. `main` and `test` stacks land on different ports automatically
//      — no app-level port table to maintain.
//
// `<stackDir>/ports.json` shape:
//
//   {
//     "sui.rpc": 9059,
//     "sui.faucet": 9984,
//     "walrus.node": [19185, 19186, 19187, 19188]
//   }
//
// Plugin authors call `ctx.ports.allocate({ slot, preferred?, count? })`.
// `preferred` is honored when free (lets pinned-port apps keep their
// numbers). `count` allocates a contiguous range (walrus storage nodes).
// Calls are idempotent — re-allocating the same slot returns the
// already-assigned port(s) without re-checking the OS.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

import type { PortAllocator, PortRequest } from '../core/types.js';
import { stackDir } from './active-stack.js';

export type { PortAllocator, PortRequest };

interface PortFile {
	[slot: string]: number | number[];
}

const CONTIGUOUS_RETRY_LIMIT = 16;

/** Disk-backed allocator. Reads `<stackDir>/ports.json` lazily on first
 * `allocate`, writes through on every new assignment. */
export function createPortAllocator(opts: { appDir: string; stack: string }): PortAllocator {
	const path = resolve(stackDir(opts.appDir, opts.stack), 'ports.json');
	const cache: PortFile = readPortFile(path);

	return {
		async allocate(req) {
			const count = req.count ?? 1;
			if (count < 1) {
				throw new Error(`port-allocator: count must be >= 1 (got ${count})`);
			}
			const existing = cache[req.slot];
			if (existing !== undefined) {
				const arr = Array.isArray(existing) ? existing : [existing];
				if (arr.length !== count) {
					throw new Error(
						`port-allocator: slot '${req.slot}' previously allocated ${arr.length} ports ` +
							`but now requests ${count}. Drop the stack to reset, or change the slot name.`,
					);
				}
				return arr;
			}
			const ports = await pickPorts({ count, preferred: req.preferred, taken: collectTaken(cache) });
			cache[req.slot] = ports.length === 1 ? (ports[0] as number) : ports;
			writePortFile(path, cache);
			return ports;
		},
	};
}

/** In-memory allocator for tests. No disk I/O, no socket binds —
 * deterministic port numbers from a counter. */
export function createInMemoryPortAllocator(opts: { startAt?: number } = {}): PortAllocator {
	const cache = new Map<string, number[]>();
	let next = opts.startAt ?? 30000;
	return {
		async allocate(req) {
			const count = req.count ?? 1;
			if (count < 1) {
				throw new Error(`port-allocator: count must be >= 1 (got ${count})`);
			}
			const existing = cache.get(req.slot);
			if (existing !== undefined) return existing;
			const start = req.preferred ?? next;
			const ports = Array.from({ length: count }, (_, i) => start + i);
			const last = ports[ports.length - 1];
			if (last !== undefined) next = Math.max(next, last + 1);
			cache.set(req.slot, ports);
			return ports;
		},
	};
}

function readPortFile(path: string): PortFile {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as PortFile;
	} catch {
		return {};
	}
}

function writePortFile(path: string, data: PortFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
	renameSync(tmp, path);
}

function collectTaken(data: PortFile): Set<number> {
	const set = new Set<number>();
	for (const v of Object.values(data)) {
		if (Array.isArray(v)) for (const p of v) set.add(p);
		else set.add(v);
	}
	return set;
}

interface PickArgs {
	count: number;
	preferred?: number;
	taken: Set<number>;
}

async function pickPorts(args: PickArgs): Promise<number[]> {
	if (args.preferred !== undefined) {
		const candidate = Array.from({ length: args.count }, (_, i) => (args.preferred as number) + i);
		if (candidate.every((p) => !args.taken.has(p)) && (await areAllFree(candidate))) {
			return candidate;
		}
	}
	for (let attempt = 0; attempt < CONTIGUOUS_RETRY_LIMIT; attempt++) {
		const first = await pickFreePort();
		const candidate = Array.from({ length: args.count }, (_, i) => first + i);
		if (candidate.every((p) => !args.taken.has(p)) && (await areAllFree(candidate))) {
			return candidate;
		}
	}
	throw new Error(
		`port-allocator: could not find ${args.count} contiguous free ports after ${CONTIGUOUS_RETRY_LIMIT} attempts`,
	);
}

/** Bind to :0, read back the kernel-assigned port, release. */
async function pickFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const server = createServer();
		server.unref();
		server.once('error', rej);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (typeof addr !== 'object' || addr === null) {
				server.close();
				rej(new Error('port-allocator: failed to resolve assigned port'));
				return;
			}
			const port = addr.port;
			server.close(() => res(port));
		});
	});
}

async function areAllFree(ports: number[]): Promise<boolean> {
	for (const port of ports) {
		if (!(await isFree(port))) return false;
	}
	return true;
}

async function isFree(port: number): Promise<boolean> {
	return new Promise((res) => {
		const server = createServer();
		server.unref();
		server.once('error', () => res(false));
		server.listen(port, '127.0.0.1', () => {
			server.close(() => res(true));
		});
	});
}
