// Seal plugin — key-server-config.yaml renderer.
//
// Distilled-doc invariant #19: the `network: !Devnet` discriminator
// is LOAD-BEARING. Env-only mode silently routes at the public
// testnet fullnode regardless of `NODE_URL`; going through the
// config file with the `!Devnet` discriminator binds the daemon to
// the in-stack sui RPC.
//
// Distilled-doc invariant #20: the rendered file MUST land under
// `runtime/seal/`, NOT a scoped temp dir. The substrate's
// service-path resolver (`servicePath('seal')`) produces the host
// path; we land both the yaml and the master-key env-file there.
//
// This file declares the renderer + the staging procedure. The
// renderer is a pure string builder; the staging procedure uses the
// substrate's atomic-write primitive (FileSystem-backed).

import { Effect, FileSystem } from 'effect';

import { atomicWriteFile } from '../../substrate/runtime/atomic-write.ts';
import { sealConfigError, sealError, type SealError } from './errors.ts';
import { KEY_SERVER_CONFIG_BASENAME, MASTER_KEY_ENVFILE_BASENAME } from './keygen.ts';
import { SealSpans } from './spans.ts';

// ---------------------------------------------------------------------------
// Render inputs
// ---------------------------------------------------------------------------

/** Inputs the renderer consumes. The substrate provides the
 *  sui node URL (in-container DNS form, e.g. `http://sui-localnet:9000`)
 *  + the seal package id + the on-chain key-server object id. */
export interface SealKeyServerConfigInputs {
	/** Seal Move package id (from publish). */
	readonly sealPackageId: string;
	/** Sui RPC node URL as seen from inside the container's network. */
	readonly nodeUrl: string;
	/** On-chain `KeyServer` object id (from register). */
	readonly keyServerObjectId: string;
	/** Optional ts-sdk version requirement override. Default is the
	 *  pin distilled from v3 (`'>=0.4.5'`); v2 plans expose this so
	 *  consumers running older `@mysten/seal` aren't silently
	 *  rejected. Distilled-doc opportunity #8. */
	readonly tsSdkVersionRequirement?: string;
}

export interface ParsedSealKeyServerConfig {
	readonly sealPackageId: string;
	readonly nodeUrl: string;
	readonly keyServerObjectId: string;
}

const DEFAULT_TS_SDK_REQUIREMENT = '>=0.4.5';

// ---------------------------------------------------------------------------
// Render — pure string builder
// ---------------------------------------------------------------------------

/** Allowed character set for raw interpolation into a YAML double-quoted
 *  string. A `"` would close the quote and let downstream characters
 *  inject YAML syntax; a backslash would start an escape sequence the
 *  parser then chokes on. Sui/Seal object ids + node URLs only need
 *  alphanumerics, `:/_.-`, and `0x` — so the conservative whitelist is
 *  safe. The `ts_sdk_version_requirement` allows the SemVer comparator
 *  characters as well. */
const YAML_INTERP_FIELD_RE = /^[0-9a-zA-Z:/_.\-]+$/;
const YAML_INTERP_SEMVER_RE = /^[0-9a-zA-Z:/_.\-<>=^~* |!]+$/;

const assertYamlSafe = (field: string, value: string, pattern: RegExp): string => {
	if (pattern.test(value)) return value;
	throw sealConfigError({
		field,
		message: `seal.config-render: ${field} contains characters that would break YAML quoting`,
		hint: `allowed characters: ${pattern.source}`,
	});
};

/** Render the key-server config yaml.
 *
 *  Distilled-doc invariant #19: `network: !Devnet` is hardcoded.
 *  This is the "custom chain via node_url" discriminator the
 *  upstream binary expects when devstack supplies its own RPC.
 *
 *  Each interpolated value is whitelist-asserted BEFORE rendering — a
 *  `"` in any field would close the YAML quoted string and let
 *  downstream characters inject syntax. The assertion raises a
 *  `SealConfigError({phase: 'config-render'})` naming the offending
 *  field so callers see a typed refusal, not silently-broken YAML. */
export const renderSealKeyServerConfig = (inputs: SealKeyServerConfigInputs): string => {
	const sealPackageId = assertYamlSafe('sealPackageId', inputs.sealPackageId, YAML_INTERP_FIELD_RE);
	const nodeUrl = assertYamlSafe('nodeUrl', inputs.nodeUrl, YAML_INTERP_FIELD_RE);
	const keyServerObjectId = assertYamlSafe(
		'keyServerObjectId',
		inputs.keyServerObjectId,
		YAML_INTERP_FIELD_RE,
	);
	const tsReq = assertYamlSafe(
		'tsSdkVersionRequirement',
		inputs.tsSdkVersionRequirement ?? DEFAULT_TS_SDK_REQUIREMENT,
		YAML_INTERP_SEMVER_RE,
	);
	return [
		'network: !Devnet',
		`  seal_package: "${sealPackageId}"`,
		`node_url: "${nodeUrl}"`,
		'server_mode: !Open',
		`  key_server_object_id: "${keyServerObjectId}"`,
		`ts_sdk_version_requirement: "${tsReq}"`,
		'',
	].join('\n');
};

// ---------------------------------------------------------------------------
// Master-key env-file body
// ---------------------------------------------------------------------------

/** Render the docker `--env-file` body. Single `KEY=value` line.
 *  Distilled-doc invariant #3 — this is the ONLY path the master key
 *  reaches the container; inline `-e MASTER_KEY=…` would surface
 *  the secret in `docker inspect` and host process env. */
export const renderMasterKeyEnvFile = (masterKeyHex: string): string =>
	`MASTER_KEY=${masterKeyHex}\n`;

const readQuotedYamlField = (body: string, field: string): string | null => {
	const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Anchor to start-of-line: `(?:^|\n)` plus a whitespace-only run
	// (`[ \t]*` — explicitly excludes `#`) so a commented field
	// (`# node_url: "fake"`) can never accidentally match. The renderer
	// does not emit comments today, but the parser is also used on
	// snapshot-restore bodies that may grow comments in future. The
	// previous `\s*` admitted no `#`, but `\s` includes `\n` which let
	// the regex engine skip past the start-of-line anchor; restricting
	// to inline-whitespace makes the line-anchoring strict.
	const match = new RegExp(`(?:^|\\n)[ \\t]*${escaped}:[ \\t]*"([^"]+)"[ \\t]*(?:\\n|$)`).exec(
		body,
	);
	return match?.[1] ?? null;
};

export const parseSealKeyServerConfig = (body: string): ParsedSealKeyServerConfig | null => {
	const sealPackageId = readQuotedYamlField(body, 'seal_package');
	const nodeUrl = readQuotedYamlField(body, 'node_url');
	const keyServerObjectId = readQuotedYamlField(body, 'key_server_object_id');
	if (sealPackageId === null || nodeUrl === null || keyServerObjectId === null) {
		return null;
	}
	return { sealPackageId, nodeUrl, keyServerObjectId };
};

export const parseMasterKeyEnvFile = (body: string): string | null => {
	const match = /^MASTER_KEY=(0x)?([0-9a-fA-F]+)\s*$/m.exec(body);
	return match?.[2] ?? null;
};

// ---------------------------------------------------------------------------
// Staging procedure — write yaml + env-file with proper mode bits
// ---------------------------------------------------------------------------

/** Compose the two writes the local-keygen mode needs.
 *
 *  Writes:
 *
 *    - `${servicePath}/key-server-config.yaml` (mode 0o644 — public)
 *    - `${servicePath}/master-key.env`          (mode 0o600 — secret)
 *
 *  Parent dir is created with 0o700 (distilled-doc invariant #2).
 *  Both writes flow through the substrate's `atomicWriteFile`
 *  (tempfile + fsync + rename, never partial-write visible).
 *
 *  Distilled-doc invariant #4: `master-key.env` MUST NOT be unlinked
 *  on scope close (snapshot → restore round-trip retains the key).
 *  We do NOT register a finalizer here.
 *
 *  Error surface: `SealError({phase: 'config-render'})` wraps any
 *  underlying `AtomicWriteFailed`. The substrate's atomic write owns
 *  fsync + rename + cleanup semantics. */
export const stageSealConfig = (
	yamlBody: string,
	masterKeyHex: string,
	servicePath: string,
	name: string,
): Effect.Effect<
	{
		readonly configPath: string;
		readonly masterKeyEnvFile: string;
	},
	SealError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const configPath = `${servicePath}/${KEY_SERVER_CONFIG_BASENAME}`;
		const masterKeyEnvFile = `${servicePath}/${MASTER_KEY_ENVFILE_BASENAME}`;
		const yamlBytes = new TextEncoder().encode(yamlBody);
		const envBytes = new TextEncoder().encode(renderMasterKeyEnvFile(masterKeyHex));

		// World-readable yaml (no secrets) inside 0o700 parent — the
		// daemon process inside the container reads via the bind-mount
		// so host-side mode bits don't fully matter, but 0o644 is the
		// least-surprising default for a non-secret config.
		yield* atomicWriteFile(configPath, yamlBytes, {
			mode: 0o644,
			parentMode: 0o700,
		}).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					sealError('config-render', {
						name,
						message: `seal.config-render: failed to write ${KEY_SERVER_CONFIG_BASENAME} (${cause.stage})`,
						cause,
					}),
				),
			),
		);

		// SECRET — 0o600 inside the same 0o700 parent. Distilled-doc
		// §Hard requirements #2.
		yield* atomicWriteFile(masterKeyEnvFile, envBytes, {
			mode: 0o600,
			parentMode: 0o700,
		}).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					sealError('config-render', {
						name,
						message: `seal.config-render: failed to write ${MASTER_KEY_ENVFILE_BASENAME} (${cause.stage})`,
						cause,
					}),
				),
			),
		);

		return { configPath, masterKeyEnvFile };
	}).pipe(
		Effect.withSpan('devstack.plugin.seal.config-render.stage', {
			attributes: { [SealSpans.name]: name, [SealSpans.servicePath]: servicePath },
		}),
	);
