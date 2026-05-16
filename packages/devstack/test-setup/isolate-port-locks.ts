// Redirect the PortAllocator's cross-process rendezvous dir to a fresh
// tmpdir for the entire vitest run. Otherwise tests that exercise the
// live `PortAllocatorLive` (port-allocator, wallet, etc.) share
// `~/.devstack/ports/` with each other and with prior CI runs; leaked
// `<port>.lock` files can saturate the 100-port scan window and surface
// as `No free port found in [N, N+100]`. The override is picked up
// lazily by `defaultPortLockDir()` on first allocate.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devstack-portlocks-'));

beforeAll(() => {
	process.env.DEVSTACK_PORT_LOCK_DIR = dir;
});

afterAll(() => {
	delete process.env.DEVSTACK_PORT_LOCK_DIR;
	fs.rmSync(dir, { recursive: true, force: true });
});
