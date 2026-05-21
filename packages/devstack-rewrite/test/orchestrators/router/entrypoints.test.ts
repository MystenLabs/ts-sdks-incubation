// Entrypoint registry coverage.
//
// Architecture invariant #6:
//   - Re-registering the same `(name, port, default protocol)` is
//     idempotent.
//   - Re-registering with a conflict throws synchronously.
//   - The set is read once at router launch — registrations after
//     launch don't reach Traefik (i.e. callers don't mutate after
//     `makeEntrypointRegistry` returns).

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	DEFAULT_ENTRYPOINTS,
	makeEntrypointRegistry,
} from '../../../src/orchestrators/router/entrypoints.ts';

describe('makeEntrypointRegistry', () => {
	it('builds from a literal seed and exposes byName + all', () => {
		const reg = makeEntrypointRegistry([
			{ name: 'wallet-app', port: 6173, protocol: 'http' },
			{ name: 'walrus-aggregator', port: 9185, protocol: 'http' },
		]);
		expect(reg.all().length).toBe(2);
	});

	it('treats duplicate identical registrations as idempotent', () => {
		const reg = makeEntrypointRegistry([
			{ name: 'wallet-app', port: 6173, protocol: 'http' },
			{ name: 'wallet-app', port: 6173, protocol: 'http' },
		]);
		expect(reg.all().length).toBe(1);
	});

	it('throws synchronously on conflicting registration', () => {
		// `Schema.TaggedErrorClass` instances carry the tag on `_tag`
		// and the schema fields as own properties; `Error.prototype.message`
		// is empty (the schema doesn't reserve a `message` field). Inspect
		// the thrown shape directly rather than matching `.message`.
		let thrown: unknown;
		try {
			makeEntrypointRegistry([
				{ name: 'wallet-app', port: 6173, protocol: 'http' },
				{ name: 'wallet-app', port: 7000, protocol: 'http' },
			]);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		const err = thrown as {
			_tag: string;
			name: string;
			existing: { port: number };
			attempted: { port: number };
		};
		expect(err._tag).toBe('EntrypointConflict');
		expect(err.name).toBe('wallet-app');
		expect(err.existing.port).toBe(6173);
		expect(err.attempted.port).toBe(7000);
	});

	it.effect('byName fails UnknownEntrypoint for missing names', () =>
		Effect.gen(function* () {
			const reg = makeEntrypointRegistry([{ name: 'wallet-app', port: 6173, protocol: 'http' }]);
			const err = yield* reg.byName('not-there').pipe(Effect.flip);
			expect(err._tag).toBe('UnknownEntrypoint');
			expect(err.known).toContain('wallet-app');
		}),
	);

	it('DEFAULT_ENTRYPOINTS includes the in-tree plugin endpoints', () => {
		const reg = makeEntrypointRegistry(DEFAULT_ENTRYPOINTS);
		const names = new Set(reg.all().map((e) => e.name));
		// Every in-tree plugin's Routable.endpointName must be registered.
		for (const name of [
			'wallet-app',
			'walrus-node-0',
			'walrus-aggregator',
			'walrus-publisher',
			'seal-key-server',
			'deepbook-server',
			'deepbook-server-metrics',
			'deepbook-indexer-metrics',
		]) {
			expect(names.has(name)).toBe(true);
		}
	});

	it('DEFAULT_ENTRYPOINTS carries TCP entries for postgres and redis', () => {
		const reg = makeEntrypointRegistry(DEFAULT_ENTRYPOINTS);
		const byName = new Map(reg.all().map((e) => [e.name, e]));
		expect(byName.get('postgres-tcp')?.protocol).toBe('tcp');
		expect(byName.get('postgres-tcp')?.port).toBe(5432);
		expect(byName.get('redis-tcp')?.protocol).toBe('tcp');
		expect(byName.get('redis-tcp')?.port).toBe(6379);
	});
});
