// Structural pins for the `LivenessClassifierDecl` capability contract.
//
// The classifier decl is consumed by the L3 prune orchestrator given a
// registry entry's persisted hints. Pins the discriminated `kind`, the
// `LivenessClassification` literal union, and the `LivenessHints` shape.

import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';

import type {
	LivenessClassification,
	LivenessClassifierDecl,
	LivenessHints,
} from '../../src/contracts/liveness-classifier.ts';

describe('contracts/liveness-classifier — structural pins', () => {
	it('discriminated-union `kind` is the literal `"liveness-classifier"`', () => {
		const decl: LivenessClassifierDecl = {
			kind: 'liveness-classifier',
			classify: () => Effect.succeed('alive'),
		};
		const tagged: 'liveness-classifier' = decl.kind;
		expect(tagged).toBe('liveness-classifier');
	});

	it('`LivenessClassification` is the closed `"alive" | "dormant" | "stale" | "abandoned"` union', () => {
		const alive: LivenessClassification = 'alive';
		const dormant: LivenessClassification = 'dormant';
		const stale: LivenessClassification = 'stale';
		const abandoned: LivenessClassification = 'abandoned';
		expect([alive, dormant, stale, abandoned]).toEqual([
			'alive',
			'dormant',
			'stale',
			'abandoned',
		]);

		// @ts-expect-error -- `'running'` is not a recognized classification.
		const _bad: LivenessClassification = 'running';
		void _bad;
	});

	it('rejects a literal missing `classify` (required)', () => {
		// @ts-expect-error -- `classify` is required.
		const _bad: LivenessClassifierDecl = { kind: 'liveness-classifier' };
		void _bad;
	});

	it('classifier receives the typed `LivenessHints` and returns the classification effect', async () => {
		const hints: LivenessHints = {
			heartbeatAt: 1_700_000_000_000,
			claimPid: 1234,
			claimStartTime: 567,
			pluginHints: { mode: 'attached' },
		};
		const decl: LivenessClassifierDecl = {
			kind: 'liveness-classifier',
			classify: (h) =>
				h.heartbeatAt === null ? Effect.succeed('abandoned') : Effect.succeed('alive'),
		};
		const result = await Effect.runPromise(decl.classify(hints));
		expect(result).toBe('alive');

		const stale = await Effect.runPromise(
			decl.classify({
				heartbeatAt: null,
				claimPid: null,
				claimStartTime: null,
				pluginHints: {},
			}),
		);
		expect(stale).toBe('abandoned');
	});

	it('`LivenessHints.pluginHints` is the opaque per-plugin slot', () => {
		// The architecture deliberately keeps `pluginHints` as
		// `Readonly<Record<string, unknown>>`: the orchestrator never
		// inspects per-plugin shapes.
		const hints: LivenessHints = {
			heartbeatAt: null,
			claimPid: null,
			claimStartTime: null,
			pluginHints: { anyKey: { nested: true } },
		};
		expect(hints.pluginHints.anyKey).toEqual({ nested: true });
	});
});
