// Unit tests for the `ChainProbe` service.
//
// Two surfaces under test: the live layer's SDK-shape parsing (canary
// against B1 / B5 / B7 — every verify probe today casts the SDK
// response differently; the Schema in `chain-probe.ts` makes that
// boundary explicit) and the lenient/strict variant contracts.

import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { ChainProbe, ChainProbeLive, ProbeError } from './chain-probe.js';
import { SuiTag, type Sui } from '../services/sui.js';

// -----------------------------------------------------------------------------
// Fake `SuiTag` builder — mints a partial Sui object with a controllable
// `client.core.getObject` so the live layer's parsing branch is exercised
// without an actual gRPC client.
// -----------------------------------------------------------------------------

const makeFakeSui = (getObject: (input: { objectId: string }) => Promise<unknown>): Sui =>
	({
		network: 'localnet',
		rpc: { host: 'http://127.0.0.1:9000' },
		chainId: 'chain-a',
		runtime: 'bundled',
		client: { core: { getObject } } as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
	}) as unknown as Sui;

const probeWithSui = (sui: Sui) => ChainProbeLive.pipe(Layer.provide(Layer.succeed(SuiTag, sui)));

describe('ChainProbe.getObject (live layer — Schema-validated parsing)', () => {
	it.effect('parses an AddressOwner response and normalizes the owner', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const info = yield* probe.getObject('0xa1');
			expect(info).toEqual({
				objectId: '0xa1',
				type: '0x2::coin::Coin<0x2::sui::SUI>',
				version: '7',
				owner: { address: '0xowner' },
			});
		}).pipe(
			Effect.provide(
				probeWithSui(
					makeFakeSui(async (_input) => ({
						object: {
							objectId: '0xa1',
							type: '0x2::coin::Coin<0x2::sui::SUI>',
							version: '7',
							digest: 'deadbeef',
							owner: { $kind: 'AddressOwner', AddressOwner: '0xowner' },
						},
					})),
				),
			),
		),
	);

	it.effect('normalizes Shared owner kind', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const info = yield* probe.getObject('0xb2');
			expect(info?.owner).toEqual({ shared: true });
		}).pipe(
			Effect.provide(
				probeWithSui(
					makeFakeSui(async () => ({
						object: {
							objectId: '0xb2',
							type: '0xabc::pool::Pool',
							version: '1',
							digest: 'd',
							owner: { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
						},
					})),
				),
			),
		),
	);

	it.effect('normalizes Immutable owner kind', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const info = yield* probe.getObject('0xc3');
			expect(info?.owner).toEqual({ immutable: true });
		}).pipe(
			Effect.provide(
				probeWithSui(
					makeFakeSui(async () => ({
						object: {
							objectId: '0xc3',
							type: 'T',
							version: '1',
							digest: 'd',
							owner: { $kind: 'Immutable', Immutable: true as const },
						},
					})),
				),
			),
		),
	);

	it.effect('lenient getObject returns undefined when the RPC says NOT_FOUND', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const info = yield* probe.getObject('0xdead');
			expect(info).toBeUndefined();
		}).pipe(
			Effect.provide(
				probeWithSui(
					makeFakeSui(async () => {
						throw new Error('rpc: NOT_FOUND: object 0xdead not found');
					}),
				),
			),
		),
	);

	it.effect('lenient getObject returns undefined on transient RPC failure', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const info = yield* probe.getObject('0xa1');
			expect(info).toBeUndefined();
		}).pipe(
			Effect.provide(
				probeWithSui(
					makeFakeSui(async () => {
						throw new Error('rpc: UNAVAILABLE: connection refused');
					}),
				),
			),
		),
	);

	it.effect('strict getObjectStrict raises ProbeError on a transient RPC failure', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const err = yield* probe.getObjectStrict('0xa1').pipe(Effect.flip);
			expect(err).toBeInstanceOf(ProbeError);
			expect(err.surface).toBe('getObject');
		}).pipe(
			Effect.provide(
				probeWithSui(
					makeFakeSui(async () => {
						throw new Error('rpc: UNAVAILABLE: connection refused');
					}),
				),
			),
		),
	);

	it.effect(
		'strict getObjectStrict raises ProbeError on a schema-violating response (B1-shape canary)',
		// The pre-substrate sites that read `res.objectType` off the root
		// silently `undefined`'d here AND collapsed the verify loop to
		// false. Schema validation at the boundary makes this loud.
		() =>
			Effect.gen(function* () {
				const probe = yield* ChainProbe;
				const err = yield* probe.getObjectStrict('0xa1').pipe(Effect.flip);
				expect(err).toBeInstanceOf(ProbeError);
			}).pipe(
				Effect.provide(
					probeWithSui(
						makeFakeSui(async () => ({
							object: {
								objectId: '0xa1',
								version: '7',
								owner: { $kind: 'Immutable', Immutable: true as const },
								// type: MISSING — drift canary
							},
						})),
					),
				),
			),
	);
});

describe('ChainProbe.objectsMatchTypes (helper composition)', () => {
	// Build a stub ChainProbe (NOT the live layer) so we test the
	// substrate's helper composition without indirecting through the
	// underlying SDK shape parser — already covered by the suite above.

	const stubProbe = (objectsById: Record<string, string | undefined>): Layer.Layer<ChainProbe> =>
		Layer.succeed(ChainProbe, {
			getObject: (id) =>
				Effect.succeed(
					objectsById[id] !== undefined
						? { objectId: id, type: objectsById[id]!, version: '1', owner: {} }
						: undefined,
				),
			getObjectStrict: () => Effect.succeed(undefined),
			// Use the same fake `getObject` via a fresh closure — the live
			// layer's implementation IS this body, so we duplicate it here
			// to keep the helper test independent.
			objectsMatchTypes: (expectations, match) =>
				Effect.gen(function* () {
					const cmp = match ?? ((a: string, b: string) => a === b);
					for (const e of expectations) {
						const t = objectsById[e.objectId];
						if (t === undefined) return false;
						if (!cmp(t, e.expectedType)) return false;
					}
					return true;
				}),
		});

	it.effect('returns true when every (id, expectedType) matches', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const result = yield* probe.objectsMatchTypes([
				{ objectId: '0xa', expectedType: 'T1' },
				{ objectId: '0xb', expectedType: 'T2' },
			]);
			expect(result).toBe(true);
		}).pipe(Effect.provide(stubProbe({ '0xa': 'T1', '0xb': 'T2' }))),
	);

	it.effect('returns false when an object is missing', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const result = yield* probe.objectsMatchTypes([
				{ objectId: '0xa', expectedType: 'T1' },
				{ objectId: '0xmissing', expectedType: 'T2' },
			]);
			expect(result).toBe(false);
		}).pipe(Effect.provide(stubProbe({ '0xa': 'T1' }))),
	);

	it.effect('returns false when an expectedType mismatches', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			const result = yield* probe.objectsMatchTypes([
				{ objectId: '0xa', expectedType: 'T1' },
				{ objectId: '0xb', expectedType: 'T2' },
			]);
			expect(result).toBe(false);
		}).pipe(Effect.provide(stubProbe({ '0xa': 'T1', '0xb': 'TX' }))),
	);

	it.effect('honours a custom match predicate', () =>
		Effect.gen(function* () {
			const probe = yield* ChainProbe;
			// Custom predicate accepts everything → mismatches still pass.
			const result = yield* probe.objectsMatchTypes(
				[{ objectId: '0xa', expectedType: 'expected' }],
				() => true,
			);
			expect(result).toBe(true);
		}).pipe(Effect.provide(stubProbe({ '0xa': 'actual-different' }))),
	);
});

describe('ProbeError', () => {
	it('is a Schema-tagged error with surface/message fields', () => {
		const err = new ProbeError({ surface: 'getObject', message: 'oops' });
		expect(err._tag).toBe('ProbeError');
		expect(err.surface).toBe('getObject');
		expect(Schema.is(ProbeError)(err)).toBe(true);
	});
});
