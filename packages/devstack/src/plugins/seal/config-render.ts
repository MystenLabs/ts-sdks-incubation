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
import { sealError, type SealError } from './errors.ts';
import { KEY_SERVER_CONFIG_BASENAME, MASTER_KEY_ENVFILE_BASENAME } from './keygen.ts';

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

const DEFAULT_TS_SDK_REQUIREMENT = '>=0.4.5';

// ---------------------------------------------------------------------------
// Render — pure string builder
// ---------------------------------------------------------------------------

/** Render the key-server config yaml.
 *
 *  Distilled-doc invariant #19: `network: !Devnet` is hardcoded.
 *  This is the "custom chain via node_url" discriminator the
 *  upstream binary expects when devstack supplies its own RPC. */
export const renderSealKeyServerConfig = (inputs: SealKeyServerConfigInputs): string => {
	const tsReq = inputs.tsSdkVersionRequirement ?? DEFAULT_TS_SDK_REQUIREMENT;
	return [
		'network: !Devnet',
		`  seal_package: "${inputs.sealPackageId}"`,
		`node_url: "${inputs.nodeUrl}"`,
		'server_mode: !Open',
		`  key_server_object_id: "${inputs.keyServerObjectId}"`,
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
			attributes: { 'seal.name': name, 'seal.servicePath': servicePath },
		}),
	);
