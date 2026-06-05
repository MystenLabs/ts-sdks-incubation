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
//  - index.ts `start` forwards `handle.networkAlias` into the codegen
//    bindings (Stage B: emitted inline via `ctx.codegen`, replacing
//    the legacy `capabilities` closure).

import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
	CodegenEmitContext,
	CodegenEmitDone,
	CodegenableDecl,
} from '../../../src/contracts/codegenable.ts';
import type { ContainerRuntime } from '../../../src/contracts/container-runtime.ts';
import { postgres } from '../../../src/plugins/postgres/index.ts';
import type { Postgres, PostgresServiceOptions } from '../../../src/plugins/postgres/service.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import { PluginContext } from '../../../src/substrate/plugin-ctx.ts';
import { ContainerRuntimeService } from '../../../src/runtime/docker/service.ts';
import { IdentityContext, StackPathsService } from '../../../src/substrate/runtime/paths.ts';
import { makeTestPluginCtx } from '../../helpers/test-plugin-ctx.ts';

const APP = 'private-content';
const STACK = 'main';
const STACK_ROOT = '/tmp/codegen-host-test-stack-root';

const identity: Identity = {
	app: appName(APP),
	stack: stackName(STACK),
	chain: 'sui:local',
};

/** Minimal `ContainerRuntime` fake that lets `bootPostgresService` run
 *  to completion and produce a deterministic `Postgres` handle. The
 *  handle the boot builds mirrors what the daemon would resolve:
 *  `host` is the per-stack container DNS name, `networkAlias` is the
 *  parallel-stack-portable `<name>-<stack>` alias. The two MUST differ
 *  for the test to discriminate the bug. Mirrors the fake in
 *  `service.test.ts`; only the methods `start` reaches are live. */
const fakeRuntime: ContainerRuntime = {
	ensureImage: () => Effect.succeed({ digest: 'sha256:postgres', tag: 'devstack-postgres:test' }),
	ensureNetwork: () => Effect.succeed('postgres-net'),
	ensureContainer: (spec) =>
		Effect.sync(() => ({
			id: 'postgres-container-id',
			name: spec.name,
			imageName: spec.image.tag ?? spec.image.digest,
			status: 'running' as const,
			ips: [],
			labels: spec.labels,
		})),
	// pg_isready: ready immediately.
	exec: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
	runOneShot: () => Effect.die('runOneShot not used'),
	inspectByLabels: () => Effect.die('inspectByLabels not used'),
	followLogs: () => Stream.empty,
	pause: () => Effect.die('pause not used'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: () => Effect.die('loadImage not used'),
	tagImage: () => Effect.die('tagImage not used'),
	removeImage: () => Effect.die('removeImage not used'),
	unpause: () => Effect.die('unpause not used'),
	stop: () => Effect.die('stop not used'),
	sweepOrphans: () => Effect.die('sweepOrphans not used'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
	removeManagedImages: () => Effect.die('removeManagedImages not used'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
};

/** A complete-enough `StackPaths` stub. `start` reads only `stackRoot`;
 *  the helper fields are present to satisfy the service shape. */
const stackPaths = StackPathsService.of({
	stackRoot: STACK_ROOT,
	cacheDir: `${STACK_ROOT}/cache`,
	snapshotDir: `${STACK_ROOT}/snapshots`,
	stackLockFile: `${STACK_ROOT}/stack.lock`,
	rosterFile: `${STACK_ROOT}/roster.json`,
	containerClaimsFile: `${STACK_ROOT}/container-claims.json`,
	cacheEntry: (namespace, chain, contentHash) => ({
		dir: `${STACK_ROOT}/cache/${namespace}/${chain}`,
		file: `${STACK_ROOT}/cache/${namespace}/${chain}/${contentHash}`,
	}),
	cacheChainDir: (namespace, chain) => `${STACK_ROOT}/cache/${namespace}/${chain}`,
	cacheNamespaceDir: (namespace) => `${STACK_ROOT}/cache/${namespace}`,
});

/** Drive the converted plugin's `start(deps)` against the fake
 *  substrate, providing the captured ctx as the `PluginContext` service
 *  (`harness.provide`). Returns the resolved handle (start's success
 *  value) and the codegen decl captured off `ctx.codegen` (Stage B
 *  replaces the legacy `capabilities` closure with this inline emission). */
const runStart = (
	opts: PostgresServiceOptions,
): Promise<{ handle: Postgres; codegen: CodegenableDecl }> => {
	const { provide, captured } = makeTestPluginCtx();
	const plugin = postgres(opts);
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const handle = (yield* provide(
					(plugin.start as (deps: unknown) => Effect.Effect<Postgres, never, PluginContext>)(
						undefined,
					),
				)) as Postgres;
				const codegen = captured.codegen[0];
				if (codegen === undefined) throw new Error('codegen decl missing from ctx capture');
				return { handle, codegen: codegen as CodegenableDecl };
			}).pipe(
				Effect.provideService(ContainerRuntimeService, fakeRuntime),
				Effect.provideService(IdentityContext, identity),
				Effect.provideService(StackPathsService, stackPaths),
			),
		),
	);
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

describe('postgres codegen host', () => {
	it('emits the per-stack network alias (not the per-stack container name)', async () => {
		const { handle, codegen } = await runStart({});
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
		const { codegen } = await runStart({ name: 'orders' });
		const exported = await Effect.runPromise(captureExports(codegen));
		const bindings = exported['postgresConnection'] as { readonly host: string };

		expect(bindings.host).toBe(`orders-${STACK}`);
		expect(bindings.host).not.toBe(`${APP}-${STACK}-orders`);
	});
});
