// `connectPostgres(url)` — thin promise-returning wrapper around the
// `pg` driver for use in real-Docker tests. Returns a `{query, end}`
// handle so tests don't have to repeat connection-string parsing
// + lifecycle management.
//
// The `pg` package isn't a project dependency yet; tests that import
// this helper will require it via the standard `pg` shape — failing
// import lands a clear error pointing the test author at the package
// to install. Today, only L3 docker tests use this; CI scrubs add `pg`
// if + when they run.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PgClient {
	readonly query: <T = unknown>(
		sql: string,
		params?: ReadonlyArray<unknown>,
	) => Promise<{
		readonly rows: ReadonlyArray<T>;
		readonly rowCount: number | null;
	}>;
	readonly end: () => Promise<void>;
}

/**
 * Connect to a Postgres URL and return a typed query/end handle.
 * Lazily imports `pg` so tests that don't reach this code path don't
 * fail with a missing-dep error at module load. A test that does call
 * this and finds `pg` unavailable gets a clear error.
 */
export const connectPostgres = async (url: string): Promise<PgClient> => {
	const mod = (await import('pg').catch(() => undefined)) as
		| { Client?: new (opts: { connectionString: string }) => any }
		| undefined;
	if (mod?.Client === undefined) {
		throw new Error(
			'connectPostgres: the `pg` package is required for L3 docker tests. ' +
				'Install via `pnpm add -D pg`.',
		);
	}
	const client = new mod.Client({ connectionString: url });
	await client.connect();
	return {
		query: async (sql: string, params?: ReadonlyArray<unknown>) => {
			const result = await client.query(sql, params as unknown[]);
			return { rows: result.rows, rowCount: result.rowCount };
		},
		end: async () => {
			await client.end();
		},
	};
};
