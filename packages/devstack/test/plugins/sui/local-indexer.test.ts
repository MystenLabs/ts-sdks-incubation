// Sui local-mode external GraphQL indexer wiring.
//
// GraphQL is gated on an external postgres (sui-tools ships no embedded
// Postgres). Supplying `indexerDb` turns GraphQL on, declares a typed
// `dependsOn` on the postgres ref, and composes the indexer DSN from the
// resolved handle's NETWORK ALIAS (not the per-stack container DNS name).

import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';

import { sui } from '../../../src/plugins/sui/index.ts';
import { resolveLocalIndexer } from '../../../src/plugins/sui/index.ts';
import { postgresResource } from '../../../src/plugins/postgres/index.ts';
import type { Postgres } from '../../../src/plugins/postgres/index.ts';

const fakePostgres = (overrides: Partial<Postgres> = {}): Postgres => ({
	name: 'postgres',
	user: 'devstack',
	password: 'pg-secret',
	host: 'app-stack-postgres',
	port: 5432,
	databases: ['devstack', 'sui_indexer'],
	endpoint: 'postgres://devstack:pg-secret@app-stack-postgres:5432',
	plainEndpoint: 'postgres://app-stack-postgres:5432',
	url: (db) => `postgres://devstack:pg-secret@app-stack-postgres:5432/${db}`,
	containerNetwork: 'devstack-app-stack-postgres',
	networkAlias: 'postgres-stack',
	...overrides,
});

describe('Sui local indexer wiring', () => {
	it('declares a postgres dependsOn when indexerDb is set', () => {
		const pg = postgresResource;
		const plugin = sui({ mode: 'local', indexerDb: { postgres: pg } });
		expect(plugin.dependsOn).toContain(pg);
	});

	it('plain sui() declares no postgres dependency', () => {
		const plugin = sui();
		expect(plugin.dependsOn).not.toContain(postgresResource);
	});

	it('composes the indexer DSN from the postgres networkAlias, not the DNS host', async () => {
		const pg = fakePostgres();
		const indexer = await Effect.runPromise(resolveLocalIndexer(pg, 'sui_indexer'));
		expect(indexer.url).toBe('postgres://devstack:pg-secret@postgres-stack:5432/sui_indexer');
		expect(indexer.network).toBe('devstack-app-stack-postgres');
		// The credentialed cluster DNS host must NOT leak into the DSN.
		expect(indexer.url).not.toContain('app-stack-postgres');
	});

	it('fails when the indexer database is not declared on the postgres plugin', async () => {
		const pg = fakePostgres({ databases: ['devstack'] });
		const exit = await Effect.runPromiseExit(resolveLocalIndexer(pg, 'sui_indexer'));
		expect(Exit.isFailure(exit)).toBe(true);
		const err = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
		expect(err?._tag).toBe('Some');
		const value = err?._tag === 'Some' ? err.value : undefined;
		expect(value).toMatchObject({ _tag: 'SuiPluginError', phase: 'container-start' });
		expect(value?.message).toContain('sui_indexer');
	});
});
