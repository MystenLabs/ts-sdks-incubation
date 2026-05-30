// Postgres codegen `host` must emit the per-stack network alias
// (`<name>-<stack>`) — the alias Docker registers via
// `--network-alias` on the primary attach. The alias is parallel-
// stack-portable; the per-stack container name resolves too but
// would burn the stack name into committed codegen output.
//
// Architecture parallel:
//  - service.ts:314 passes `{ name: containerNetwork, aliases:
//    [networkAlias] }` as the first `networkAttach` entry, so
//    Docker registers the alias as a DNS entry on the attached
//    network (see runtime/docker/container.ts:451+).
//  - index.ts capability factory forwards `value.networkAlias` into
//    the codegen bindings.

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
	CodegenEmitContext,
	CodegenEmitDone,
	CodegenableDecl,
} from '../../../src/contracts/codegenable.ts';
import { postgres } from '../../../src/plugins/postgres/index.ts';
import type { Postgres, PostgresServiceOptions } from '../../../src/plugins/postgres/service.ts';
import { appName, chainId, stackName } from '../../../src/substrate/brand.ts';
import type { AcquireContext } from '../../../src/substrate/plugin.ts';

const APP = 'private-content';
const STACK = 'main';

const identity = {
	app: appName(APP),
	stack: stackName(STACK),
	chain: chainId('sui:local'),
};

const runtimeCtx: AcquireContext = {
	identity,
	chain: chainId('sui:local'),
	runtimeRoot: '/tmp/codegen-host-test-runtime-root',
};

/** Build a Postgres handle that mirrors what `service.ts` resolves at
 *  runtime: `host` is the container DNS name, `networkAlias` is the
 *  (currently un-plumbed) in-network alias. The two MUST differ for
 *  the test to discriminate the bug. */
const makePostgresHandle = (opts: PostgresServiceOptions): Postgres => {
	const name = opts.name ?? 'postgres';
	const containerName = `${APP}-${STACK}-${name}`;
	const networkAlias = `${name}-${STACK}`;
	return {
		name,
		user: 'devstack',
		password: 'pg-private-contentmain',
		host: containerName,
		port: 5432,
		databases: ['devstack'],
		endpoint: `postgres://devstack:pg-private-contentmain@${containerName}:5432`,
		plainEndpoint: `postgres://${containerName}:5432`,
		url: (db) => `postgres://devstack:pg-private-contentmain@${containerName}:5432/${db}`,
		containerNetwork: `devstack-${APP}-${STACK}-postgres`,
		networkAlias,
	};
};

/** Drive a `CodegenableDecl.emit` and capture the exported record. */
const captureExports = (decl: CodegenableDecl): Effect.Effect<Record<string, unknown>> => {
	const exports: Record<string, unknown> = {};
	const ctx: CodegenEmitContext = {
		exportConst: (name, value) => {
			exports[name] = value;
		},
		importStatement: () => {},
		done: (): CodegenEmitDone => ({ _tag: 'CodegenEmitDone' }),
	};
	return decl.emit(ctx).pipe(Effect.as(exports));
};

const findCodegen = (caps: ReadonlyArray<{ readonly kind: string }>): CodegenableDecl => {
	const decl = caps.find((c) => c.kind === 'codegenable');
	if (decl === undefined) throw new Error('codegen decl missing from capabilities');
	return decl as CodegenableDecl;
};

describe('postgres codegen host', () => {
	it('emits the per-stack network alias (not the per-stack container name)', async () => {
		const plugin = postgres();
		const handle = makePostgresHandle({});

		// Capability factory accepts the lowered `(value, runtime)` form
		// after substrate normalization (substrate/plugin.ts:298-301).
		const caps = (
			plugin.capabilities as (
				value: Postgres,
				runtime: AcquireContext,
			) => ReadonlyArray<{ readonly kind: string }>
		)(handle, runtimeCtx);

		const codegen = findCodegen(caps);
		const exported = await Effect.runPromise(captureExports(codegen));

		const bindings = exported['postgresConnection'] as {
			readonly host: string;
			readonly url: string;
			readonly plainUrl: string;
		};

		// Host MUST equal the resolved handle's `networkAlias`
		// (`<name>-<stack>`). The per-stack container name resolves
		// too, but committing it burns the stack name into codegen.
		expect(bindings.host).toBe(`postgres-${STACK}`);
		expect(bindings.host).toBe(handle.networkAlias);
		expect(bindings.host).not.toBe(handle.host);

		// URLs derived from the same host must also use the alias
		// (catches the case where someone fixes `host` but leaves
		// `url`/`plainUrl` dialing the container name).
		expect(bindings.url).toContain(`@postgres-${STACK}:5432`);
		expect(bindings.plainUrl).toBe(`postgres://postgres-${STACK}:5432`);
	});

	it('honours a custom postgres name when emitting host', async () => {
		const plugin = postgres({ name: 'orders' });
		const handle = makePostgresHandle({ name: 'orders' });

		const caps = (
			plugin.capabilities as (
				value: Postgres,
				runtime: AcquireContext,
			) => ReadonlyArray<{ readonly kind: string }>
		)(handle, runtimeCtx);

		const codegen = findCodegen(caps);
		const exported = await Effect.runPromise(captureExports(codegen));
		const bindings = exported['postgresConnection'] as { readonly host: string };

		expect(bindings.host).toBe(`orders-${STACK}`);
		expect(bindings.host).not.toBe(`${APP}-${STACK}-orders`);
	});
});
