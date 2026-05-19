// L1 unit tests for `DeepbookServer(opts)` — factory shape verification.
//
// Full container-side behavior (REST API responses, snapshot/restore
// roundtrip, concurrent-stack port allocation) lives at L3 in
// `server.docker.test.ts` and the deepbook-snapshot regression test.
// Here we lock in the contract surface that DOESN'T need Docker: the
// returned tag shape, the layer composition (composite + tagLayer),
// and the kind marker.

import { describe, expect, it } from 'vitest';
import { DeepbookServer } from './server.js';

// Stub tags for the required postgres/sui/deepbook deps. We don't
// resolve them — just type-thread them into the factory so the call
// site mirrors the real consumer shape.
const stubTag = (): any => ({}) as any;

describe('DeepbookServer factory shape (P3.T1 L1)', () => {
	it('returns a tag-shaped value with __kind=service and a __layer', () => {
		const server = DeepbookServer({
			name: 'deepbook-server-test',
			postgres: stubTag(),
			sui: stubTag(),
			deepbook: stubTag(),
		});

		expect(typeof server).toBe('function');
		expect((server as unknown as { __kind?: string }).__kind).toBe('service');
		// LayeredTag's `__layer` is set; `__layers` carries the
		// composite + tagLayer pair.
		expect((server as unknown as { __layer?: unknown }).__layer).toBeDefined();
		const layers = (server as unknown as { __layers?: ReadonlyArray<unknown> }).__layers;
		expect(layers).toBeDefined();
		expect(layers!.length).toBeGreaterThanOrEqual(2);
	});

	it('defaults to `deepbook-server` for the name when omitted', () => {
		const server = DeepbookServer({
			postgres: stubTag(),
			sui: stubTag(),
			deepbook: stubTag(),
		});
		expect((server as unknown as { __displayTitle?: string }).__displayTitle).toBe(
			'deepbook.server.deepbook-server',
		);
	});

	it('accepts an optional margin Ref', () => {
		const server = DeepbookServer({
			name: 'deepbook-server-margin',
			postgres: stubTag(),
			sui: stubTag(),
			deepbook: stubTag(),
			margin: stubTag(),
		});
		expect((server as unknown as { __kind?: string }).__kind).toBe('service');
	});
});
