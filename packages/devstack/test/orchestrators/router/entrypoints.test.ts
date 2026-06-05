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

import { makeEntrypointRegistry } from '../../../src/orchestrators/router/entrypoints.ts';
import { BUILT_IN_ENTRYPOINTS } from '../../../src/plugins/router-entrypoints.ts';

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

	it.effect('keeps HTTP aliases lookupable while exposing one listener per port', () =>
		Effect.gen(function* () {
			const reg = makeEntrypointRegistry([
				{ name: 'walrus-node-0', port: 9185, protocol: 'http' },
				{ name: 'walrus-node-1', port: 9185, protocol: 'http' },
				{ name: 'walrus-aggregator', port: 9185, protocol: 'http' },
			]);

			expect(reg.all()).toEqual([{ name: 'walrus-node-0', port: 9185, protocol: 'http' }]);
			const alias = yield* reg.byName('walrus-aggregator');
			expect(alias).toEqual({ name: 'walrus-node-0', port: 9185, protocol: 'http' });

			const err = yield* reg.byName('not-there').pipe(Effect.flip);
			expect(err.known).toContain('walrus-aggregator');
		}),
	);

	it('throws synchronously when one port mixes HTTP and TCP families', () => {
		let thrown: unknown;
		try {
			makeEntrypointRegistry([
				{ name: 'http-api', port: 8080, protocol: 'http' },
				{ name: 'raw-api', port: 8080, protocol: 'tcp' },
			]);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		const err = thrown as {
			_tag: string;
			name: string;
			existing: { protocol: string };
			attempted: { protocol: string };
		};
		expect(err._tag).toBe('EntrypointConflict');
		expect(err.name).toBe('raw-api');
		expect(err.existing.protocol).toBe('http');
		expect(err.attempted.protocol).toBe('tcp');
	});

	it('throws synchronously when two TCP entrypoints share one port', () => {
		let thrown: unknown;
		try {
			makeEntrypointRegistry([
				{ name: 'postgres-primary', port: 5432, protocol: 'tcp' },
				{ name: 'postgres-replica', port: 5432, protocol: 'tcp' },
			]);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		const err = thrown as {
			_tag: string;
			name: string;
			existing: { port: number; protocol: string };
			attempted: { port: number; protocol: string };
		};
		expect(err._tag).toBe('EntrypointConflict');
		expect(err.name).toBe('postgres-replica');
		expect(err.existing).toEqual({ port: 5432, protocol: 'tcp' });
		expect(err.attempted).toEqual({ port: 5432, protocol: 'tcp' });
	});

	it('BUILT_IN_ENTRYPOINTS includes the in-tree plugin endpoints', () => {
		const reg = makeEntrypointRegistry(BUILT_IN_ENTRYPOINTS);
		// Every in-tree plugin's Routable.endpointName must be registered.
		for (const name of [
			'rpc',
			'faucet',
			'graphql',
			'dev',
			'wallet-app',
			'walrus-node-0',
			'walrus-node-1',
			'walrus-aggregator',
			'walrus-publisher',
			'seal-key-server',
		]) {
			expect(Effect.runSync(reg.byName(name))).toBeDefined();
		}
		expect(reg.all().filter((entrypoint) => entrypoint.port === 9185)).toHaveLength(1);
	});

	it('BUILT_IN_ENTRYPOINTS includes the app dev entrypoint without conflicting names or ports', () => {
		const reg = makeEntrypointRegistry(BUILT_IN_ENTRYPOINTS);
		const dev = Effect.runSync(reg.byName('dev'));
		expect(dev).toEqual({ name: 'dev', port: 5175, protocol: 'http' });
		expect(reg.all().filter((entrypoint) => entrypoint.port === 5175)).toEqual([dev]);
		expect(BUILT_IN_ENTRYPOINTS.map((entrypoint) => entrypoint.name)).not.toContain(
			'frontend.dev-server',
		);
		expect(BUILT_IN_ENTRYPOINTS.some((entrypoint) => entrypoint.name.includes('.'))).toBe(false);
	});

	it('BUILT_IN_ENTRYPOINTS excludes removed plugin-owned TCP entries', () => {
		const reg = makeEntrypointRegistry(BUILT_IN_ENTRYPOINTS);
		expect(Effect.runSync(reg.byName('postgres-tcp').pipe(Effect.flip))._tag).toBe(
			'UnknownEntrypoint',
		);
		expect(BUILT_IN_ENTRYPOINTS.map((entrypoint) => entrypoint.name)).not.toContain('redis-tcp');
	});
});
