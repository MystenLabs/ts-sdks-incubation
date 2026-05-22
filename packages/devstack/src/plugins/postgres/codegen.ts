// Postgres plugin — Codegenable contribution.
//
// Architecture §6: plugins emit typed `CodegenableDecl`s; the codegen
// orchestrator stages files into the user's source tree WITHOUT
// naming the plugin. Postgres's contribution is the connection
// surface — credentialed URL + parsed parts so downstream user-app
// code can construct `DATABASE_URL` strings (or feed a typed
// connection record into a pg client) without re-deriving creds.
//
// Sensitive flag: the emitted file carries the password, so the
// codegen orchestrator marks it 0o600 inside its parent (0o700). The
// manifest projection (separate from codegen) strips the password
// via the substrate's secret-redactor pattern.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import {
	credentialedUrl,
	plainUrl,
	type PostgresConnectionBindings,
	type PostgresConnectionParts,
} from './connection.ts';

export interface MakeCodegenableOptions {
	readonly name: string;
	readonly user: string;
	readonly password: string;
	readonly host: string;
	readonly port: number;
	readonly databases: ReadonlyArray<string>;
}

/** Construct the Codegenable contribution. Emit is byte-deterministic
 *  on unchanged input (architecture: no mtime churn on no-op cycles).
 *
 *  The emitted shape carries both the credentialed URL (for in-app
 *  dialers) and the plain URL (for code paths that log or persist the
 *  endpoint). */
export const makeCodegenable = (
	opts: MakeCodegenableOptions,
): CodegenableDecl<'postgres-connection'> => {
	const parts: PostgresConnectionParts = {
		user: opts.user,
		password: opts.password,
		host: opts.host,
		port: opts.port,
	};

	return {
		kind: 'codegenable',
		emitterName: 'postgres-connection',
		// One file per postgres instance. Multiple postgres()
		// instances on the same stack would collide here — distilled
		// doc § Edge cases notes this as a name-collision foot-gun;
		// the substrate's codegen layer detects the collision and
		// fails with a typed error before write.
		outputPath: `postgres/${opts.name}.ts`,
		sensitive: true,
		emit: (ctx) =>
			Effect.sync(() => {
				const bindings: PostgresConnectionBindings = {
					name: opts.name,
					host: opts.host,
					port: opts.port,
					user: opts.user,
					password: opts.password,
					databases: opts.databases,
					url: credentialedUrl(parts),
					plainUrl: plainUrl(opts.host, opts.port),
					database: opts.databases[0]!,
				};
				ctx.exportConst('postgresConnection', bindings);
				return ctx.done();
			}),
	};
};
