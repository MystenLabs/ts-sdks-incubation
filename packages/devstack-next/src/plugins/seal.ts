import type { Keypair } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { defineSchema, type SchemaInstanceConfig } from '../factories/define-schema.js';
import { gitFetch } from '../helpers/git-fetch.js';
import { publishMove } from '../helpers/publish-move.js';
import { publishViaSuiCli } from '../helpers/publish-via-cli.js';
import { dockerContainer } from '../runners/docker-container.js';
import type { Endpoint, Package } from '../shapes/index.js';
import { sui } from './sui.js';

const DEFAULT_SEAL_IMAGE = 'mystenlabs/seal-key-server:latest';
const DEFAULT_KEY_SERVER_CONTAINER_PORT = 2024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Pinned seal release tag. Doubles as a git ref for the upstream Move
 * package fetch. */
export const SEAL_DEFAULT_VERSION = 'seal-v0.6.6';
const SEAL_REPO = 'MystenLabs/seal';
const SEAL_MOVE_SUBDIR = 'move/seal';

/** Boneh-Franklin BLS12-381 — the only `KEY_TYPE` accepted by upstream
 * (`seal/move/seal/sources/key_server.move`). */
const KEY_TYPE_BONEH_FRANKLIN_BLS12381 = 0;

export interface SealOptions {
	/** Override the key-server image. Default
	 * `mystenlabs/seal-key-server:latest`. */
	image?: string;
	/** Container port the key-server binds inside the container. Host
	 * port is allocated. Default 2024 (upstream's default). */
	containerPort?: number;
	/** Ready-probe timeout for the key-server. Default 60s. */
	readyTimeoutMs?: number;
	/** Skip Docker entirely — point the producer at an externally-managed
	 * key server. Mirrors the `sui({ rpcUrl })` escape hatch. */
	url?: string;
}

export interface SealState {
	url: string;
	managed: boolean;
}

const provides = {
	keyServer: dep((s: SealState) => ({ url: s.url })),
	url: dep((s: SealState) => s.url),
	full: dep((s: SealState) => s),
} satisfies Provides<SealState>;

// `seal` schema. `seal.create({})` returns a single producer:
//   - Default → a pure transformer that depends on a private
//     `dockerContainer({...})` running the seal key-server. Plugin code
//     never calls docker directly; the runner handles spawn + ready
//     probe + warm-restart liveness, exposing `provides.state` /
//     `provides.hostPort` for the transformer to project a clean
//     SealState.
//   - `url` override → a stub producer that just publishes the supplied
//     URL. Used when the key server is managed externally (or in tests).
//
// Both branches expose the same `provides`: keyServer ({ url }), url
// (string), full (state) — so consumer code is mode-agnostic.
//
// Static use: `seal.get('keyServer')` returns a Dep with `__pluginId`;
// the engine binds it to the running instance at graph-build time.
//
// Localnet publish + register flows live in `sealLocalnet({...})` (a
// sibling factory) — they don't fold into the schema because the on-
// chain bootstrap depends on a publisher signer the schema doesn't own.
export const seal = defineSchema<SealOptions, SealState, typeof provides>({
	id: 'seal',
	provides,
	create: (opts): SchemaInstanceConfig<SealState, typeof provides, any> => {
		if (opts.url !== undefined) return staticInstance(opts.url);
		return managedInstance(opts);
	},
});

function managedInstance(
	opts: SealOptions,
): SchemaInstanceConfig<SealState, typeof provides, any> {
	const image = opts.image ?? DEFAULT_SEAL_IMAGE;
	const containerPort = opts.containerPort ?? DEFAULT_KEY_SERVER_CONTAINER_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

	const container = dockerContainer({
		name: 'seal.key-server.container',
		runsAs: 'seal',
		image,
		ports: [{ slot: 'seal.key-server', containerPort }],
		readyTimeoutMs,
	});

	return {
		name: 'seal.key-server',
		deps: { hostPort: container.get('hostPort', { slot: 'seal.key-server' }) },
		start: async ({ deps: { hostPort } }): Promise<SealState> => ({
			url: `http://127.0.0.1:${hostPort}`,
			managed: true,
		}),
		represents: {
			endpoints: (s: SealState): Endpoint[] => [
				{ name: 'seal-key-server', url: s.url, kind: 'seal-key-server' },
			],
		},
	};
}

function staticInstance(url: string): SchemaInstanceConfig<SealState, typeof provides, any> {
	return {
		name: 'seal.key-server',
		start: async (): Promise<SealState> => ({ url, managed: false }),
		represents: {
			endpoints: (s: SealState): Endpoint[] => [
				{ name: 'seal-key-server', url: s.url, kind: 'seal-key-server' },
			],
		},
	};
}

export interface SealLocalnetOptions {
	/** Publisher signer for both publish + register. Typically
	 * `accounts.get('signer', { name: 'publisher' })`. */
	signer: Dep<unknown, Keypair>;
	/** Hex-encoded BLS12-381 public key. Must pair with the master key
	 * loaded into the seal key-server container's `MASTER_KEY` env.
	 * Generated by `seal-cli genkey` on a one-time bootstrap; cache the
	 * pair on disk and re-supply both on subsequent runs. */
	publicKeyHex: string;
	/** Pinned seal release tag. Default `'seal-v0.6.6'` — must match
	 * `SEAL_DEFAULT_VERSION` baked into the key-server image. */
	version?: string;
	/** On-chain `KeyServer.name` field. Default `devstack-local`. */
	keyServerName?: string;
}

export interface SealRegisterState {
	package: Package;
	keyServerObjectId: string;
	keyServerUrl: string;
	keyServerName: string;
}

const registerProvides = {
	full: dep((s: SealRegisterState) => s),
	keyServer: dep((s: SealRegisterState) => ({
		objectId: s.keyServerObjectId,
		url: s.keyServerUrl,
		name: s.keyServerName,
	})),
} satisfies Provides<SealRegisterState>;

// `sealLocalnet({...})` — bundle of publish + register producers for
// localnet bring-up. Returns:
//   - `publish`: `publishMove` against the upstream `move/seal` Move
//     package fetched via `gitFetch`. Provides the seal Package
//     (manifest / bindings consumers pivot on this).
//   - `register`: a `define()` that calls
//     `key_server::create_and_transfer_v2_independent_server` on the
//     just-published seal package. Reads the key-server URL from the
//     `seal` schema instance's `full` Dep so it adapts to the docker-
//     allocated host port.
//
// Both producers chain `sui.get('rpc')` ambiently; the engine pulls the
// running sui instance into the graph transitively. Caller threads in
// the publisher signer + the public-key hex (paired with the master
// key the key-server container loads — keep them in sync via a
// one-time `seal-cli genkey` bootstrap).
export function sealLocalnet(opts: SealLocalnetOptions) {
	const version = opts.version ?? SEAL_DEFAULT_VERSION;
	const keyServerName = opts.keyServerName ?? 'devstack-local';

	const source = gitFetch({
		name: 'seal.source',
		repo: SEAL_REPO,
		rev: version,
		subdir: SEAL_MOVE_SUBDIR,
	});

	const publish = publishMove({
		name: 'seal',
		path: source.get('path'),
		signer: opts.signer,
		publish: publishViaSuiCli,
	});

	const register = define<SealRegisterState, typeof registerProvides>({
		name: 'seal.register',
		runsAs: 'publisher',
		deps: {
			signer: opts.signer,
			rpc: sui.get('rpc'),
			pkg: publish.get('package'),
			keyServer: seal.get('full'),
		},
		provides: registerProvides,
		start: async ({ deps }) => {
			const d = deps as {
				signer: Keypair;
				rpc: { url: string };
				pkg: Package;
				keyServer: SealState;
			};
			const pkBytes = decodeHex(opts.publicKeyHex);
			const tx = new Transaction();
			tx.moveCall({
				target: `${d.pkg.packageId}::key_server::create_and_transfer_v2_independent_server`,
				arguments: [
					tx.pure.string(keyServerName),
					tx.pure.string(d.keyServer.url),
					tx.pure.u8(KEY_TYPE_BONEH_FRANKLIN_BLS12381),
					tx.pure.vector('u8', Array.from(pkBytes)),
				],
			});
			const client = new SuiJsonRpcClient({ url: d.rpc.url, network: 'localnet' });
			const result = await client.signAndExecuteTransaction({
				signer: d.signer,
				transaction: tx,
				options: { showObjectChanges: true, showEffects: true },
			});
			if (result.effects?.status.status !== 'success') {
				throw new Error(
					`seal.register: KeyServer publish failed: ${result.effects?.status.error ?? 'unknown'}`,
				);
			}
			await client.waitForTransaction({ digest: result.digest });
			const created = (result.objectChanges ?? []).find(
				(c: SuiObjectChange) =>
					c.type === 'created' &&
					typeof c.objectType === 'string' &&
					c.objectType.endsWith('::key_server::KeyServer'),
			);
			const objectId = created && 'objectId' in created ? created.objectId : undefined;
			if (objectId === undefined) {
				throw new Error(
					`seal.register: KeyServer object not in objectChanges: ${JSON.stringify(result.objectChanges)}`,
				);
			}
			return {
				package: d.pkg,
				keyServerObjectId: objectId,
				keyServerUrl: d.keyServer.url,
				keyServerName,
			};
		},
	});

	return { publish, register, source };
}

function decodeHex(s: string): Uint8Array {
	const hex = s.startsWith('0x') ? s.slice(2) : s;
	if (hex.length % 2 !== 0) {
		throw new Error(`seal.register: hex string has odd length: ${s.length}`);
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
