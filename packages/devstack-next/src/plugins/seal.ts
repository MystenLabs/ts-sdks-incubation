import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Keypair } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiObjectChange } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import type { Dep, Env, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { defineSchema, type SchemaInstanceConfig } from '../factories/define-schema.js';
import { gitFetch } from '../helpers/git-fetch.js';
import { publishMove } from '../helpers/publish-move.js';
import { publishViaSuiCli } from '../helpers/publish-via-cli.js';
import { dockerContainer } from '../runners/docker-container.js';
import { dockerImage } from '../runners/docker-image.js';
import { dockerOneShot } from '../runners/docker-one-shot.js';
import type { Endpoint, Package } from '../shapes/index.js';
import { sui } from './sui.js';

// Vendored Dockerfile ships under `src/plugins/seal/docker/`.
// `tsdown.config.ts` mirrors it to `dist/plugins/seal/docker/` so
// `import.meta.url` resolves the same path in source and built outputs.
const DOCKER_CONTEXT = fileURLToPath(new URL('./seal/docker/', import.meta.url));

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
	/** Pre-built key-server image. When set, the `seal.image` build is
	 * skipped and the literal tag is used directly. Useful for
	 * CI-published images or pinning to an upstream tag. */
	image?: string;
	/** Pinned seal release tag, e.g. `'seal-v0.6.6'`. Becomes a
	 * `--build-arg SEAL_TAG=<tag>` to the vendored Dockerfile and the
	 * git ref used to fetch the matching `move/seal` Move package via
	 * `gitFetch`. Defaults to `SEAL_DEFAULT_VERSION`. */
	version?: string;
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
	/** Hex-encoded BLS12-381 master key. Set in managed mode (sourced
	 * from the per-stack `seal.keygen` producer); undefined when running
	 * against an externally-managed key server (`url:` override). */
	masterKey?: string;
	/** Hex-encoded BLS12-381 public key paired with `masterKey`. Same
	 * managed-mode-only semantics. `sealLocalnet({...}).register` Deps
	 * on this so the on-chain `KeyServer.public_key` matches the master
	 * key the key-server container loads at boot. */
	publicKey?: string;
}

const provides = {
	keyServer: dep((s: SealState) => ({ url: s.url })),
	url: dep((s: SealState) => s.url),
	full: dep((s: SealState) => s),
	masterKey: dep((s: SealState) => {
		if (s.masterKey === undefined) {
			throw new Error('seal.masterKey: only available in managed mode (no `url:` override)');
		}
		return s.masterKey;
	}),
	publicKey: dep((s: SealState) => {
		if (s.publicKey === undefined) {
			throw new Error('seal.publicKey: only available in managed mode (no `url:` override)');
		}
		return s.publicKey;
	}),
} satisfies Provides<SealState>;

export interface SealKeygenState {
	masterKey: string;
	publicKey: string;
	generatedAt: number;
}

const keygenProvides = {
	masterKey: dep((s: SealKeygenState) => s.masterKey),
	publicKey: dep((s: SealKeygenState) => s.publicKey),
	full: dep((s: SealKeygenState) => s),
} satisfies Provides<SealKeygenState>;

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
	const containerPort = opts.containerPort ?? DEFAULT_KEY_SERVER_CONTAINER_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const version = opts.version ?? SEAL_DEFAULT_VERSION;

	// Image: build from the vendored Dockerfile via `dockerImage` unless
	// the caller pinned a pre-built tag. Same content-addressed pattern
	// as `sui.image` / `walrus.image*` — a `version` bump or Dockerfile
	// edit flips the tag, which in turn flips the container's input
	// hash and triggers a recreate.
	const image =
		opts.image !== undefined
			? opts.image
			: dockerImage({
					name: 'seal.image',
					context: { path: DOCKER_CONTEXT },
					args: { SEAL_TAG: version },
				});
	const imageRef = typeof image === 'string' ? image : image.get('tag');

	// Keygen chain. The dockerOneShot runs `seal-cli genkey` once; the
	// transformer parses its tail and persists to a 0600 disk file under
	// `<stackDir>/.keys/`. On subsequent runs (snapshot wipe but disk
	// kept; or just warm restart with stable inputs) the transformer
	// returns the cached file contents — fresh keys on every cycle would
	// silently invalidate the on-chain `KeyServer` registration.
	const keygenContainer = dockerOneShot({
		name: 'seal.keygen.container',
		runsAs: 'seal-keygen',
		image: imageRef,
		entrypoint: 'seal-cli',
		args: ['genkey'],
	});

	const keygenDeps = { container: keygenContainer.get('full') };
	const keygen = define<SealKeygenState, typeof keygenProvides, typeof keygenDeps>({
		name: 'seal.keygen',
		runsAs: 'seal-keygen',
		deps: keygenDeps,
		provides: keygenProvides,
		start: async ({ env, deps }) => {
			const cached = readSealKeygenFile(env);
			if (cached !== undefined) return cached;
			const tail = deps.container.tail;
			const keys = parseSealKeygenOutput(tail);
			const state: SealKeygenState = { ...keys, generatedAt: Date.now() };
			writeSealKeygenFile(env, state);
			return state;
		},
	});

	const container = dockerContainer({
		name: 'seal.key-server.container',
		runsAs: 'seal',
		image: imageRef,
		deps: { masterKey: keygen.get('masterKey') },
		containerEnv: ({ deps }) => ({ MASTER_KEY: deps.masterKey }),
		ports: [{ slot: 'seal.key-server', containerPort }],
		readyTimeoutMs,
	});

	return {
		name: 'seal.key-server',
		deps: {
			hostPort: container.get('hostPort', { slot: 'seal.key-server' }),
			keys: keygen.get('full'),
		},
		start: async ({ deps: { hostPort, keys } }): Promise<SealState> => ({
			url: `http://127.0.0.1:${hostPort}`,
			managed: true,
			masterKey: keys.masterKey,
			publicKey: keys.publicKey,
		}),
		represents: {
			endpoints: (s: SealState): Endpoint[] => [
				{ name: 'seal-key-server', url: s.url, kind: 'seal-key-server' },
			],
		},
	};
}

// Parse `seal-cli genkey` stdout. Format (one line each):
//   Master key: <hex>
//   Public key: <hex>
// Both are BLS12-381 elements; the hex prefix may or may not include
// `0x` depending on the seal-cli build. The on-chain `vector<u8>`
// argument expects raw bytes, so we strip `0x` later.
export function parseSealKeygenOutput(stdout: string): {
	masterKey: string;
	publicKey: string;
} {
	const masterMatch = stdout.match(/^Master key:\s*(\S+)/m);
	const publicMatch = stdout.match(/^Public key:\s*(\S+)/m);
	const master = masterMatch?.[1];
	const pub = publicMatch?.[1];
	if (master === undefined || pub === undefined) {
		throw new Error(
			`seal.keygen: could not parse seal-cli genkey output (last 1KB):\n${stdout.slice(-1024)}`,
		);
	}
	return { masterKey: master, publicKey: pub };
}

function sealKeygenPath(env: Env): string {
	return join(env.appDir, '.devstack', 'stacks', env.stack ?? 'main', '.keys', 'seal-master-key.json');
}

function readSealKeygenFile(env: Env): SealKeygenState | undefined {
	const path = sealKeygenPath(env);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SealKeygenState>;
		if (
			typeof parsed.masterKey !== 'string' ||
			typeof parsed.publicKey !== 'string' ||
			typeof parsed.generatedAt !== 'number'
		) {
			return undefined;
		}
		return {
			masterKey: parsed.masterKey,
			publicKey: parsed.publicKey,
			generatedAt: parsed.generatedAt,
		};
	} catch {
		// Corrupt cache file — fall through to re-parse the container's
		// fresh tail. Old devstack used the same "best-effort cache" model.
		return undefined;
	}
}

function writeSealKeygenFile(env: Env, state: SealKeygenState): void {
	const path = sealKeygenPath(env);
	mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
//     allocated host port, and the matching BLS public key from
//     `seal.get('publicKey')` (sourced from `seal.keygen` — paired
//     with the master key the key-server container loads at boot).
//
// All producers chain `sui.get('rpc')` ambiently; the engine pulls the
// running sui instance into the graph transitively. Caller threads in
// the publisher signer; everything else (publish source, public key)
// flows from existing graph nodes.
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
			publicKey: seal.get('publicKey'),
			keyServer: seal.get('full'),
		},
		provides: registerProvides,
		start: async ({ deps }) => {
			const d = deps as {
				signer: Keypair;
				rpc: { url: string };
				pkg: Package;
				publicKey: string;
				keyServer: SealState;
			};
			const pkBytes = decodeHex(d.publicKey);
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
