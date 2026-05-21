import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context, Effect, Layer, Ref, Stream, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { defineNodePlugin } from '../../../src/api/define-plugin.ts';
import type { RoutableDecl } from '../../../src/contracts/routable.ts';
import {
	buildProductionOrchestratorSinks,
	endpointEventFromRoutable,
	productionRouterProfile,
} from '../../../src/orchestrators/runtime-composition.ts';
import {
	RouterService,
	resolveDockerContextId,
	type BootReport,
	type EndpointUrl,
	type ResolvedRoute,
	type RouterServiceShape,
} from '../../../src/orchestrators/router/index.ts';
import {
	SnapshotOrchestratorService,
	type SnapshotOrchestrator,
} from '../../../src/orchestrators/snapshot/index.ts';
import {
	CodegenOrchestratorService,
	type CodegenOrchestrator,
} from '../../../src/orchestrators/codegen/service.ts';
import {
	appName,
	chainId,
	endpointKey,
	pluginKey,
	stackName,
} from '../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../src/substrate/events.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import { supervise, type HarvestContext } from '../../../src/substrate/runtime/index.ts';
import { makeProjectionRef, updateRef } from '../../../src/substrate/runtime/projection/index.ts';
import { defineTag } from '../../../src/substrate/tag.ts';

const bootReport: BootReport = {
	decision: 'opt-out',
	containerId: null,
	networkId: null,
	imageMatches: true,
};

const endpoint: EndpointUrl = {
	endpointName: 'wallet-app',
	hostname: 'wallet.demo.localhost',
	entrypointPort: 6173,
	url: 'http://wallet.demo.localhost:6173',
	wireProtocol: 'http',
};

const routable: RoutableDecl = {
	kind: 'routable',
	endpointName: 'wallet-app',
	dispatchId: { compositeKey: 'wallet', role: 'api' },
	upstream: { type: 'host-loopback', port: 49152 },
	cors: true,
	wireProtocol: 'http',
};

const identity: Identity = {
	app: appName('router-runtime-composition'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

const RoutableTag = defineTag<'test/routable', { readonly ready: true }>(
	'test/routable',
	'test',
);

const routablePlugin = defineNodePlugin({
	provides: RoutableTag,
	consumes: [] as const,
	kind: 'leaf-long-running',
	acquire: () => Effect.succeed({ ready: true } as const),
	capabilities: [routable] as const,
});

const snapshotLayer = Layer.succeed(SnapshotOrchestratorService)({
	registerParticipant: () => Effect.void,
	registerClassifier: () => Effect.void,
	capture: () => Effect.die('unused snapshot capture'),
	restore: () => Effect.die('unused snapshot restore'),
	list: Effect.die('unused snapshot list'),
	delete: () => Effect.die('unused snapshot delete'),
	wipe: () => Effect.die('unused snapshot wipe'),
	prune: () => Effect.die('unused snapshot prune'),
} satisfies SnapshotOrchestrator);

const codegenLayer = Layer.succeed(CodegenOrchestratorService)({
	registerContribution: () => Effect.void,
	runCycle: () => Effect.die('unused codegen cycle'),
} satisfies CodegenOrchestrator);

const routerLayer = Layer.effect(
	RouterService,
	Effect.gen(function* () {
		const applied = yield* SubscriptionRef.make<ReadonlyArray<ResolvedRoute>>([]);
		return {
			boot: () => Effect.succeed(bootReport),
			contributeRoute: () => Effect.succeed(endpoint),
			applied,
		} satisfies RouterServiceShape;
	}),
);

const sinkTestLayer = Layer.mergeAll(snapshotLayer, codegenLayer, routerLayer);

describe('productionRouterProfile', () => {
	it('is profile-wide and does not vary with runtime roots', () => {
		const runtimeRootA = '/tmp/devstack-runtime-a';
		const runtimeRootB = '/tmp/devstack-runtime-b';
		const opts = { env: { DOCKER_CONTEXT: 'test-context', DOCKER_HOST: undefined } };
		const profileA = productionRouterProfile(opts);
		const profileB = productionRouterProfile(opts);

		expect(profileA).toEqual(profileB);
		expect(profileA.dispatchDir).toContain(`${profileA.id}/dispatch`);
		expect(profileA.dispatchDir).not.toContain('/tmp/devstack-router');
		expect(profileA.dispatchDir).not.toContain(runtimeRootA);
		expect(profileA.dispatchDir).not.toContain(runtimeRootB);
		expect(profileA.containerName).toContain('devstack-router-');
		expect(profileA.networkName).toContain('devstack-router-');
	});

	it('prefers daemon identity over context name when docker exposes it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-router-profile-'));
		try {
			const bin = join(dir, 'docker');
			writeFileSync(
				bin,
				[
					'#!/bin/sh',
					'if [ "$1" = "info" ]; then printf "daemon-abc123\\n"; exit 0; fi',
					'if [ "$1" = "context" ]; then printf "context-name\\n"; exit 0; fi',
					'exit 1',
					'',
				].join('\n'),
			);
			chmodSync(bin, 0o755);

			expect(
				resolveDockerContextId(
					{ bin },
					{ DOCKER_CONTEXT: 'context-name', DOCKER_HOST: 'tcp://docker.example:2375' },
				),
			).toBe('daemon:daemon-abc123');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('buildProductionOrchestratorSinks', () => {
	it('maps routable deliveries to endpoint.registered events', () => {
		expect(endpointEventFromRoutable(pluginKey('wallet#0'), endpoint, 1234)).toEqual({
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey('wallet#0:wallet-app'),
				name: 'wallet-app',
				url: 'http://wallet.demo.localhost:6173',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 1234,
			},
		});
	});

	it.effect('production routable sink publishes endpoint events through the harvest context', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const observed = yield* Ref.make<ReadonlyArray<EngineEvent>>([]);
			const sinks = yield* buildProductionOrchestratorSinks();
			const harvestCtx: HarvestContext = {
				pluginKey: pluginKey('wallet#0'),
				identity,
				publish: (event) =>
					updateRef(state, event).pipe(
						Effect.andThen(Ref.update(observed, (events) => [...events, event])),
					),
			};

			expect(sinks.routable).toBeDefined();
			yield* Effect.scoped(sinks.routable!(pluginKey('wallet#0'), routable, harvestCtx));

			const events = yield* Ref.get(observed);
			expect(events).toHaveLength(1);
			const event = events[0];
			expect(event?.tag).toBe('endpoint.registered');
			if (event?.tag !== 'endpoint.registered') {
				return yield* Effect.die('expected endpoint.registered event');
			}
			expect(event).toMatchObject({
				tag: 'endpoint.registered',
				endpoint: {
					endpointKey: endpointKey('wallet#0:wallet-app'),
					name: 'wallet-app',
					url: 'http://wallet.demo.localhost:6173',
					displayUrl: null,
					wireProtocol: 'http',
				},
			});

			const snapshot = yield* SubscriptionRef.get(state);
			expect(snapshot.endpoints).toEqual([event.endpoint]);
		}).pipe(Effect.provide(sinkTestLayer)),
	);

	it.effect('supervisor emits production endpoint events on the ordered event hub', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const sinks = yield* buildProductionOrchestratorSinks();

			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(
						{ _tag: 'Stack', members: [routablePlugin], options: {} },
						identity,
						state,
						Context.empty(),
						sinks,
					);
					const events = yield* Stream.fromQueue(handle.events).pipe(
						Stream.filter(
							(event): event is Extract<
								EngineEvent,
								{ readonly tag: 'lifecycle.statusChanged' | 'endpoint.registered' }
							> =>
								event.tag === 'lifecycle.statusChanged' ||
								event.tag === 'endpoint.registered',
						),
						Stream.take(3),
						Stream.runCollect,
					);
					const snapshot = yield* SubscriptionRef.get(state);
					return { events: [...events], snapshot };
				}),
			);

			expect(result.events.map((event) => event.tag)).toEqual([
				'lifecycle.statusChanged',
				'endpoint.registered',
				'lifecycle.statusChanged',
			]);
			const endpointEvent = result.events[1];
			expect(endpointEvent?.tag).toBe('endpoint.registered');
			if (endpointEvent?.tag !== 'endpoint.registered') {
				return yield* Effect.die('expected endpoint.registered event');
			}
			expect(endpointEvent.endpoint).toMatchObject({
				endpointKey: endpointKey('test/routable#0:wallet-app'),
				name: 'wallet-app',
				url: 'http://wallet.demo.localhost:6173',
				displayUrl: null,
				wireProtocol: 'http',
			});
			expect(result.snapshot.endpoints).toEqual([endpointEvent.endpoint]);
		}).pipe(Effect.provide(sinkTestLayer)),
	);
});
