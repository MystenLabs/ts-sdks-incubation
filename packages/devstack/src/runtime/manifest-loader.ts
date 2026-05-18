// `fromManifest(json)` — POJO accessor for the v4 manifest.
//
// Two callers:
//   - The browser-side dapp-kit subpath barrel (`/dapp-kit`) re-exports
//     this so apps can decode a manifest JSON blob without standing up
//     an Effect runtime.
//   - Non-Effect TS code (post-run inspection tools, tests) that wants
//     a typed read of the running stack.

import { Result, Schema, SchemaIssue } from 'effect';
import { jsonBigintReviver } from '../engine/json-bigint.js';
import { ManifestV4, type Manifest } from './manifest-schema.js';

const decodeManifestV4 = Schema.decodeUnknownResult(ManifestV4);
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

/** The highest manifest schema version this build of devstack natively
 *  understands. Forward-compat: manifests with a higher version emit a
 *  warning and fall through to best-effort decoding so a newer-supervisor
 *  / older-consumer mix doesn't hard-crash on unrecognized optional
 *  fields. */
const EXPECTED_VERSION = 4;

/** Returns the numeric `version` field if it's a finite number, or
 *  `undefined` otherwise. Used by the forward-compat branch to decide
 *  whether a future-version manifest should be best-effort decoded. */
const numericVersion = (raw: unknown): number | undefined => {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const r = raw as { version?: unknown };
	return typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : undefined;
};

/** Options for `fromManifest()`. */
export interface FromManifestOptions {
	/** When `true`, hard-rejects ANY version that isn't exactly v4. Use
	 *  this in CI safeguards or other contexts where a version skew is
	 *  itself a bug. Default `false` — newer-than-known manifests log a
	 *  warning and fall through to best-effort decoding so an older
	 *  consumer doesn't crash on a newer supervisor's optional-field
	 *  additions. */
	readonly strict?: boolean;
}

/** Read a v4 manifest blob and return the typed v4 shape.
 *
 *  Accepts either a parsed object OR a raw JSON string; strings are
 *  parsed with `jsonBigintReviver` so `{__bigint: "123"}` round-trips
 *  back to a `bigint` instead of an object literal — consumers
 *  expecting bigint shapes (Coin scalars, gas budgets) get the right
 *  type without remembering to wire the reviver themselves.
 *
 *  Forward-compat: a manifest with `version > EXPECTED_VERSION` is
 *  best-effort decoded (added/optional fields the schema doesn't know
 *  are ignored by typed readers) with a warning, unless `opts.strict`
 *  is set. Versions older than `EXPECTED_VERSION` hard-fail. */
export function fromManifest(raw: unknown, opts: FromManifestOptions = {}): Manifest {
	let parsed: unknown;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw, jsonBigintReviver);
		} catch (cause) {
			throw new TypeError(
				`fromManifest: failed to parse string input as JSON: ${(cause as Error).message}`,
			);
		}
	} else {
		parsed = raw;
	}
	if (parsed === null || typeof parsed !== 'object') {
		throw new TypeError('fromManifest: expected an object, got ' + typeof parsed);
	}

	const version = numericVersion(parsed);
	const rawVersion = (parsed as { version?: unknown }).version;

	// Version === 4: Schema-validate the full payload. In strict mode
	// the ParseError surfaces as a TypeError. In non-strict mode we
	// warn via the logger and fall through to a best-effort cast — the
	// caller's type narrows correctly downstream and only the offending
	// fields will read back as malformed values. Without this Schema
	// check, any v4-tagged garbage previously passed straight through
	// `as Manifest`.
	if (version === EXPECTED_VERSION) {
		const decoded = decodeManifestV4(parsed);
		if (Result.isSuccess(decoded)) return decoded.success;
		const reason = formatSchemaIssue(decoded.failure);
		if (opts.strict) {
			throw new TypeError(
				`fromManifest: v${EXPECTED_VERSION} manifest failed Schema validation:\n${reason}`,
			);
		}
		console.warn(
			`[devstack] fromManifest: v${EXPECTED_VERSION} manifest failed Schema validation, ` +
				`returning best-effort shape — typed reads of malformed fields may surprise:\n${reason}`,
		);
		return parsed as Manifest;
	}

	// Forward-compat: a future manifest version we don't know about.
	// Without strict mode we treat it as v4 (optional/added fields the
	// schema doesn't know will be ignored by downstream typed readers).
	// With strict mode (CI), fail loudly so the version skew surfaces.
	if (version !== undefined && version > EXPECTED_VERSION) {
		if (opts.strict) {
			throw new TypeError(
				`fromManifest: manifest version ${version} is newer than this build supports ` +
					`(expected ${EXPECTED_VERSION}). Update @mysten-incubation/devstack ` +
					`or pass { strict: false } to opt into best-effort forward-compat decoding.`,
			);
		}
		console.warn(
			`[devstack] fromManifest: newer manifest version ${version}, treating as v${EXPECTED_VERSION}. ` +
				`Unknown fields will be ignored. Update @mysten-incubation/devstack to read the new shape natively.`,
		);
		return { ...(parsed as Manifest), version: EXPECTED_VERSION };
	}

	throw new TypeError(
		`fromManifest: unknown manifest version ${JSON.stringify(rawVersion)} ` +
			`(supported: ${EXPECTED_VERSION}). Update @mysten-incubation/devstack.`,
	);
}
