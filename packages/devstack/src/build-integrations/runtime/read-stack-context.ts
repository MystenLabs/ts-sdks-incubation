// Sync manifest reader + projection.
//
// Read-side L5 surface. Loads the manifest envelope from disk,
// validates it via the substrate's `ManifestEnvelopeSchema`, and
// projects it to a plain TS `StackContext` consumer code can use
// without depending on Effect or Schema.
//
// Sync — apps and Playwright config-load are sync surfaces. The cost
// is one `readFileSync` and one synchronous Schema decode.
//
// Error contract:
//
//   - Missing manifest → `ManifestDiscoveryError` (with `phase`).
//   - Manifest exists but `JSON.parse` rejected the bytes →
//     `ManifestShapeError(phase: 'parse')`.
//   - Manifest parsed but failed schema validation →
//     `ManifestShapeError(phase: 'shape')`.
//   - Manifest decoded but `manifestVersion` doesn't match the
//     consumer's pinned `CURRENT_MANIFEST_VERSION` →
//     `ManifestShapeError(phase: 'version')`.
//
// All three are plain `Error` subclasses (see `./errors.ts`) so the
// caller's try / catch / instanceof flow works without importing
// Effect. The CLI / codegen surfaces can still wrap this function in
// `Effect.try` to lift the failure channel.
//
// Implementation detail: we use Effect Schema INTERNALLY for the
// envelope decode (`ManifestEnvelopeSchema` lives in the substrate),
// but the API surface is plain TS. Schema is a validation tool here,
// not an exposed type.

import { readFileSync } from 'node:fs';

import {
	decodeUnknownSync,
	ManifestEnvelopeSchema,
	parseJsonTextSync,
	type ManifestEnvelope,
	type EndpointEntry,
} from './manifest-types.ts';
import { discoverManifestPath, type DiscoverManifestPathOptions } from './discover.ts';
import { EndpointRegistry } from './endpoint-registry.ts';
import { ManifestDiscoveryError, ManifestShapeError } from './errors.ts';
import type { ResolvedEndpoint, StackContext } from './stack-context.ts';

/** Pinned manifest-envelope version this consumer build was compiled
 *  against. Must match the substrate's `CURRENT_MANIFEST_VERSION`
 *  (kept as a literal here so the read path doesn't reach into the
 *  substrate's writer module just for a number). When the substrate
 *  bumps, the consumer must bump in lockstep — the version mismatch
 *  error message names the recovery recipe. */
export const CONSUMER_MANIFEST_VERSION = 1 as const;

export interface ReadStackContextOptions extends DiscoverManifestPathOptions {
	/** Caller-supplied explicit manifest path. When set, bypasses the
	 *  walk-up (still existence-checked). Named `manifestPath` for
	 *  ergonomic parity with the CLI's `--manifest-path` flag. */
	readonly manifestPath?: string;
}

const resolveManifestPath = (opts: ReadStackContextOptions): string => {
	const override = opts.manifestPath ?? opts.override;
	const resolved = discoverManifestPath({
		...opts,
		...(override !== undefined ? { override } : {}),
		required: true,
	});
	// `required: true` throws on miss; this branch is unreachable but
	// keeps the type narrow without an `!`.
	if (resolved === undefined) {
		throw new ManifestDiscoveryError({
			phase: 'required-missing',
			message: '[devstack] manifest discovery returned undefined despite required: true',
		});
	}
	return resolved;
};

const parseAndDecode = (raw: string, manifestPath: string): ManifestEnvelope => {
	let parsed: unknown;
	try {
		parsed = parseJsonTextSync(raw, {
			source: manifestPath,
			mkError: (issue) => issue,
		});
	} catch (cause) {
		throw new ManifestShapeError({
			phase: 'parse',
			path: manifestPath,
			message:
				`[devstack] manifest at ${manifestPath} is not valid JSON ` +
				`(truncation or hand-edit). ` +
				`RECOVERY: \`rm ${manifestPath} && devstack up\` to regenerate.`,
			cause,
		});
	}
	let decoded: ManifestEnvelope;
	try {
		decoded = decodeUnknownSync(ManifestEnvelopeSchema, parsed, {
			source: manifestPath,
			mkError: (issue) => issue,
		});
	} catch (cause) {
		throw new ManifestShapeError({
			phase: 'shape',
			path: manifestPath,
			message:
				`[devstack] manifest at ${manifestPath} does not match the manifest envelope schema ` +
				`(stale shape or hand-edit). ` +
				`RECOVERY: \`rm ${manifestPath} && devstack up\` to regenerate.`,
			cause,
		});
	}
	if (decoded.manifestVersion !== CONSUMER_MANIFEST_VERSION) {
		throw new ManifestShapeError({
			phase: 'version',
			path: manifestPath,
			message:
				`[devstack] manifest at ${manifestPath} has version ${decoded.manifestVersion}, ` +
				`but this consumer was built for version ${CONSUMER_MANIFEST_VERSION}. ` +
				`RECOVERY: \`rm ${manifestPath} && devstack up\` to regenerate.`,
		});
	}
	return decoded;
};

/** Project the decoded envelope to a plain `StackContext`. */
const project = (envelope: ManifestEnvelope, manifestPath: string): StackContext => {
	const entries: ResolvedEndpoint[] = [];
	for (const raw of Object.values(envelope.endpoints)) {
		entries.push({
			name: raw.name,
			url: raw.url,
			displayUrl: raw.displayUrl,
			wireProtocol: raw.wireProtocol,
			pluginKey: raw.pluginKey,
			endpointKey: raw.endpointKey,
		});
	}
	return {
		identity: {
			app: envelope.identity.app,
			stack: envelope.identity.stack,
			network: envelope.identity.network,
		},
		manifestPath,
		manifestVersion: envelope.manifestVersion,
		endpoints: new EndpointRegistry(entries),
		// Default to an empty record when the manifest omits services.
		services: envelope.services ?? {},
		extras: envelope.extras,
	};
};

/** Reconstruct the manifest envelope from the runtime projection.
 *  Integration adapters that preserve their older envelope-shaped
 *  surfaces use this instead of duplicating endpoint-registry
 *  projection logic. */
export const manifestEnvelopeFromStackContext = (ctx: StackContext): ManifestEnvelope => ({
	identity: ctx.identity,
	manifestVersion: ctx.manifestVersion,
	services: ctx.services,
	endpoints: Object.fromEntries(
		ctx.endpoints.all().map((e): [string, EndpointEntry] => [
			e.endpointKey,
			{
				name: e.name,
				url: e.url,
				displayUrl: e.displayUrl,
				wireProtocol: e.wireProtocol,
				pluginKey: e.pluginKey,
				endpointKey: e.endpointKey,
			},
		]),
	),
	extras: ctx.extras,
});

/**
 * Sync read + decode + project. Throws `ManifestDiscoveryError` (no
 * manifest located) or `ManifestShapeError` (manifest found but
 * malformed / wrong version).
 *
 * Used by:
 *   - Apps' generated `stack-handle.ts` at startup.
 *   - Playwright config-load (`baseURL`, `webServer.url`).
 *   - CLI surfaces that prefer sync-then-Effect.try over a native
 *     Effect read.
 */
export const readStackContext = (opts: ReadStackContextOptions = {}): StackContext => {
	const manifestPath = resolveManifestPath(opts);
	let raw: string;
	try {
		raw = readFileSync(manifestPath, 'utf8');
	} catch (cause) {
		// File existed at discovery time but is unreadable now — race
		// with the supervisor's atomic-write would be a parse failure on
		// the next read; a true EACCES / disk-disconnect surfaces here.
		throw new ManifestShapeError({
			phase: 'parse',
			path: manifestPath,
			message: `[devstack] failed to read manifest at ${manifestPath}: ${String(cause)}`,
			cause,
		});
	}
	const envelope = parseAndDecode(raw, manifestPath);
	return project(envelope, manifestPath);
};
