// Warm boot-cache graph key.
//
// `--warm` captures a baseline snapshot after the first good boot and restores
// it on later boots when the resolved stack graph has the same key. The graph
// key is deliberately NOT a bespoke source/env fingerprint. Content changes
// are handled by the runtime invalidation graph:
//
//   - CacheService.publish produces when an artifact key misses or verify fails.
//   - Docker image builds produce when the build-context key misses.
//   - Container ensure recreates when image/config/runtime facts drift.
//
// Warm restore can therefore start from the old baseline, let the existing
// invalidators reconcile the live graph, and recapture only if one of those
// lower-level decisions actually produced or recreated state. Direct desired-
// state side effects that bypass those invalidators are declared explicitly
// through each plugin's `warmInputs` document.

import { createHash } from 'node:crypto';

import { Effect, Schema } from 'effect';

import { resolveGraph } from '../../substrate/runtime/lifecycle/dep-graph.ts';
import type { SupervisedStack } from '../../substrate/runtime/supervisor/types.ts';

/** Stable snapshot id the warm baseline is captured under. Matches
 *  `SNAPSHOT_ID_PATTERN` in `../snapshot/descriptor.ts`
 *  (`[A-Za-z0-9][A-Za-z0-9_-]*`, 1-128 chars). */
export const WARM_BASELINE_SNAPSHOT_ID = 'warm-baseline';

/** Fingerprint document version. Bump when the canonical document's
 *  shape changes in a way that should invalidate every existing
 *  baseline (a v-bump alone shifts the hash). */
const WARM_FINGERPRINT_VERSION = 3 as const;

/** Tagged failure for graph-key computation. */
export class WarmFingerprintError extends Schema.TaggedErrorClass<WarmFingerprintError>()(
	'WarmFingerprintError',
	{
		detail: Schema.String,
		path: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect),
	},
) {}

// -----------------------------------------------------------------------------
// Canonical stringify — local, recursive, key-sorting.
// -----------------------------------------------------------------------------

/** Recursively key-sort an object graph into a canonical form. Object
 *  keys are sorted; array order is preserved (callers sort the arrays
 *  whose order is not meaningful before handing them here). `undefined`
 *  values inside objects are dropped so an explicit `key: undefined`
 *  hashes identically to an absent key. */
export const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalize(entry));
	}
	if (value !== null && typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort((a, b) => a.localeCompare(b))) {
			const entry = source[key];
			if (entry === undefined) continue;
			out[key] = canonicalize(entry);
		}
		return out;
	}
	return value;
};

/** Canonical JSON string of a value — `canonicalize` then
 *  `JSON.stringify`. The hash input. */
export const canonicalStringify = (value: unknown): string => JSON.stringify(canonicalize(value));

const sha256Hex = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex');

const sortStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...values].sort((a, b) => a.localeCompare(b));

const graphRelevantOptions = (options: SupervisedStack['options']): unknown => {
	const { renderer: _renderer, warm: _warm, extras: _extras, codegen: _codegen, ...rest } = options;
	return rest;
};

/**
 * Compute the warm-baseline graph key — a hex sha256 over the resolved
 * dep graph, watch declarations, devstack version, and runtime identity
 * options that can move a stack to a different runtime root/network.
 */
export const computeWarmFingerprint = (args: {
	readonly stack: SupervisedStack;
	readonly devstackVersion: string;
}): Effect.Effect<string, WarmFingerprintError> =>
	Effect.gen(function* () {
		const graph = yield* resolveGraph(args.stack.members).pipe(
			Effect.mapError(
				(cause) =>
					new WarmFingerprintError({
						detail: 'warm fingerprint: stack dependency graph could not be resolved',
						cause,
					}),
			),
		);

		const nodes = [...graph.nodes.values()]
			.map((node) => ({
				key: String(node.key),
				resourceId: node.member.id,
				role: node.member.role,
				section: node.member.section,
				...(node.member.endpointSection === undefined
					? {}
					: { endpointSection: node.member.endpointSection }),
				keepAliveOnRestore: node.keepAliveOnRestore,
				upstreamKeys: sortStrings(node.upstreamKeys.map(String)),
				upstreamResources: sortStrings(node.upstreamResources.map((resource) => resource.id)),
				...(node.member.watch === undefined
					? {}
					: {
							watch: {
								paths: sortStrings(node.member.watch.paths),
								cascade: node.member.watch.cascade ?? true,
							},
						}),
				...(node.member.warmInputs === undefined ? {} : { warmInputs: node.member.warmInputs }),
			}))
			.sort((a, b) => a.key.localeCompare(b.key));

		const downstream = [...graph.downstream.entries()]
			.map(([key, children]) => ({
				key: String(key),
				children: sortStrings([...children].map(String)),
			}))
			.sort((a, b) => a.key.localeCompare(b.key));

		const doc = {
			v: WARM_FINGERPRINT_VERSION,
			devstackVersion: args.devstackVersion,
			options: graphRelevantOptions(args.stack.options),
			levels: graph.levels.map((level) => sortStrings(level.map(String))),
			nodes,
			downstream,
		};

		return sha256Hex(canonicalStringify(doc));
	});
