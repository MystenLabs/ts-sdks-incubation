import { createServer } from 'node:net';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

export interface PortRequest {
	slot: string;
}

export interface PortsState {
	map: Record<string, number>;
}

// `ports` is a standard graph node — every consumer that needs a host port
// declares a Dep on `ports.get('allocate', { slot: '<unique-id>' })`. The
// engine aggregates all PortRequests into `requests.allocate`, and on each
// cycle the node:
//
//   - Carries forward prior allocations (warm restart preserves URLs).
//   - Allocates a fresh ephemeral port for any new slot via the OS.
//
// Slots removed from the stack stay in the map — keeping a stale entry is
// cheaper than re-binding a downstream service that's still running.
export const ports = define<PortsState>({
	name: 'ports',
	provides: {
		allocate: dep((state: PortsState, req: PortRequest) => state.map[req.slot] ?? 0),
	},
	start: async ({ prior, requests }) => {
		const map = { ...(prior?.map ?? {}) };
		const seen = new Set<string>();
		for (const req of requests.allocate ?? []) {
			if (seen.has(req.slot)) continue;
			seen.add(req.slot);
			if (map[req.slot] === undefined) {
				map[req.slot] = await pickEphemeralPort();
			}
		}
		return { map };
	},
});

// Bind a server to port 0 (OS picks an ephemeral), read the assigned port,
// then close. There is a TOCTOU window between close and the consumer
// re-binding — acceptable for dev workflows on a single machine.
function pickEphemeralPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				const { port } = addr;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('ports: failed to read assigned port')));
			}
		});
	});
}
