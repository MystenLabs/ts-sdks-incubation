// Regression test for Phase 1 bug #5 (opportunities-backlog.md):
// the postgres codegen `host` must be the container DNS name that
// Docker actually answers for on the attached network, NOT the
// in-network alias (which the runtime adapter does not yet thread
// through `--network-alias`, so Docker has no DNS entry for it).
//
// Architecture parallel:
//  - service.ts:342 sets `dnsName = ${app}-${stack}-${name}` and
//    surfaces it on the resolved `Postgres` handle as `host`.
//  - The capability factory in index.ts must forward `value.host`
//    (the container DNS name) into the codegen bindings — not
//    `value.networkAlias`, which is a string without a DNS entry.
//
// When the substrate-level fix lands (Phase 5: thread `networkAlias`
// through `EnsureContainerSpec.networkAttach`), this test stays
// honest because the container-name path will still resolve and the
// invariant we encode here (codegen never emits a name Docker can't
// resolve) is unchanged.

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
	CodegenEmitContext,
	CodegenEmitDone,
	CodegenableDecl,
} from '../../../src/contracts/codegenable.ts';
import { postgres } from '../../../src/plugins/postgres/index.ts';
import type {
	Postgres,
	PostgresServiceOptions,
} from '../../../src/plugins/postgres/service.ts';
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
const captureExports = (
	decl: CodegenableDecl,
): Effect.Effect<Record<string, unknown>> => {
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

const findCodegen = (
	caps: ReadonlyArray<{ readonly kind: string }>,
): CodegenableDecl => {
	const decl = caps.find((c) => c.kind === 'codegenable');
	if (decl === undefined) throw new Error('codegen decl missing from capabilities');
	return decl as CodegenableDecl;
};

describe('postgres codegen host', () => {
	it('emits the container DNS name (host), not the bare networkAlias', async () => {
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

		// Container name MUST equal the resolved handle's `host` field
		// (which the runtime sets to `${app}-${stack}-${name}`). Anything
		// derived from `networkAlias` would resolve to `${name}-${stack}`
		// — a name Docker DNS will NOT answer for.
		expect(bindings.host).toBe(`${APP}-${STACK}-postgres`);
		expect(bindings.host).toBe(handle.host);
		expect(bindings.host).not.toBe(handle.networkAlias);

		// URLs derived from the same host must also use the DNS-resolvable
		// name (catches the case where someone fixes `host` but leaves
		// `url`/`plainUrl` dialing the alias).
		expect(bindings.url).toContain(`@${APP}-${STACK}-postgres:5432`);
		expect(bindings.plainUrl).toBe(`postgres://${APP}-${STACK}-postgres:5432`);
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

		expect(bindings.host).toBe(`${APP}-${STACK}-orders`);
		expect(bindings.host).not.toBe(`orders-${STACK}`);
	});
});
