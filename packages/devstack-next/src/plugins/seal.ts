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
import { dockerNetwork } from '../runners/docker-network.js';
import { dockerOneShot } from '../runners/docker-one-shot.js';
import type { Endpoint, Package } from '../shapes/index.js';
import { ports } from '../standard/ports.js';
import { sui, SUI_LOCALNET_NETWORK_ALIAS } from './sui.js';

/** Port slot the seal key-server claims via the standard `ports`
 * allocator. Shared between the dockerContainer (which auto-Deps via
 * its `ports:` config) and the register step (which Deps directly so
 * the on-chain URL can be constructed before the container exists). */
const SEAL_KEY_SERVER_PORT_SLOT = 'seal.key-server';

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
	/** Skip Docker entirely — point the producer at an externally-managed
	 * key server. Mirrors the `sui({ rpcUrl })` escape hatch. */
	url?: string;
	/** Resolved key-server host port. Required for managed mode —
	 * sealLocalnet pre-allocates the slot via `ports.get('allocate',
	 * { slot: 'seal.key-server' })` so register can submit the
	 * matching on-chain URL before the container exists.
	 * `Dep<any, …>` to accept either the parameterized port allocator
	 * Dep (`{slot}`) or a plain dockerContainer hostPort Dep. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	hostPortDep?: Dep<any, number>;
	/** Resolved keygen full state. The schema transformer projects
	 * `masterKey` / `publicKey` from this into `SealState` so the
	 * `seal.get('publicKey')` Dep used by register resolves without
	 * cycling back through the schema. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	keygenDep?: Dep<any, SealKeygenState>;
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

// Managed instance is now a thin transformer: it just projects the
// pre-allocated host port + keygen state into `SealState`. The actual
// docker work (image, keygen one-shot, key-server container) is
// orchestrated by `sealLocalnet({...})` so it can break the cycle
// between register (needs publicKey + URL) and the key-server
// container (needs register's keyServerObjectId).
function managedInstance(
	opts: SealOptions,
): SchemaInstanceConfig<SealState, typeof provides, any> {
	if (opts.hostPortDep === undefined || opts.keygenDep === undefined) {
		throw new Error(
			'seal.create: managed mode requires `hostPortDep` + `keygenDep` from sealLocalnet. ' +
				'Pass `url:` to point at an externally-managed key server, or use ' +
				'`sealLocalnet({ signer })` which wires the schema instance for you.',
		);
	}
	return {
		name: 'seal.key-server',
		deps: {
			hostPort: opts.hostPortDep,
			keys: opts.keygenDep,
		},
		start: async ({ deps }): Promise<SealState> => {
			const d = deps as { hostPort: number; keys: SealKeygenState };
			return {
				url: `http://127.0.0.1:${d.hostPort}`,
				managed: true,
				masterKey: d.keys.masterKey,
				publicKey: d.keys.publicKey,
			};
		},
		represents: {
			endpoints: (s: SealState): Endpoint[] => [
				{ name: 'seal-key-server', url: s.url, kind: 'seal-key-server' },
			],
		},
	};
}

/** Render the seal key-server's CONFIG_PATH yaml. The daemon's env-only
 * mode silently forces `network: Testnet` and a public-fullnode
 * URL — for sui-localnet we MUST go through CONFIG_PATH. The
 * `!Devnet` discriminator is what the binary expects for "custom
 * chain via node_url"; `seal_package` is the on-chain seal package
 * id (used to fetch session keys via Move call), and the Open-mode
 * `key_server_object_id` is the registered `KeyServer` object the
 * daemon reads its own metadata from on boot. */
export function renderSealKeyServerConfig(opts: {
	sealPackageId: string;
	keyServerObjectId: string;
	tsSdkVersionRequirement?: string;
}): string {
	const tsSdk = opts.tsSdkVersionRequirement ?? '>=0.4.5';
	return [
		'# Generated by devstack-next seal plugin.',
		'# CONFIG_PATH-based config — env-only mode silently routes at the',
		'# public testnet fullnode regardless of NODE_URL, so we must use',
		'# this file to bind the daemon to sui-localnet via the per-stack',
		'# docker network alias.',
		'network: !Devnet',
		`  seal_package: '${opts.sealPackageId}'`,
		`node_url: http://${SUI_LOCALNET_NETWORK_ALIAS}:9000`,
		'server_mode: !Open',
		`  key_server_object_id: '${opts.keyServerObjectId}'`,
		`ts_sdk_version_requirement: '${tsSdk}'`,
		'',
	].join('\n');
}

function sealKeyServerConfigPath(env: Env): string {
	return join(
		env.appDir,
		'.devstack',
		'stacks',
		env.stack ?? 'main',
		'.generated',
		'seal-key-server-config.yaml',
	);
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

// `Dep<any, Keypair>` (TData covariance: parameterized + no-data both
// satisfy contravariant TData). `Dep<unknown, …>` rejected name-keyed
// signer Deps (`pool.get('signer', { name })` returns
// `Dep<{name}, …>`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignerDep = Dep<any, Keypair>;

export interface SealLocalnetOptions {
	/** Publisher signer for both publish + register. Typically
	 * `accounts.get('signer', { name: 'publisher' })`. */
	signer: SignerDep;
	/** Pre-built key-server image. When set, the `seal.image` build is
	 * skipped and the literal tag is used directly. */
	image?: string;
	/** Pinned seal release tag. Default `'seal-v0.6.6'`. Becomes a
	 * `--build-arg SEAL_TAG` to the vendored Dockerfile and the git ref
	 * the `move/seal` package fetch uses. */
	version?: string;
	/** Container port the key-server binds inside the container. Host
	 * port is allocated. Default 2024 (upstream's default). */
	containerPort?: number;
	/** Ready-probe timeout for the key-server. Default 60s. */
	readyTimeoutMs?: number;
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
	keyServerObjectId: dep((s: SealRegisterState) => s.keyServerObjectId),
} satisfies Provides<SealRegisterState>;

// `sealLocalnet({...})` — full localnet bring-up of the seal stack.
// Owns:
//   - `seal.image` — content-addressed `dockerImage` build (binary
//     fetch from the seal release; no rust compile).
//   - `seal.keygen.container` + `seal.keygen` — `seal-cli genkey` once,
//     parsed and persisted to `<stackDir>/.keys/`.
//   - `seal.source` + `publish.seal` — gitFetch + publishMove against
//     the upstream `move/seal` package via `publishViaSuiCli`.
//   - `seal.register` — `key_server::create_and_transfer_v2_independent_server`
//     Move call. Uses the pre-allocated host port to compute the
//     on-chain URL BEFORE the key-server container starts (breaks the
//     register ↔ container ↔ schema cycle).
//   - `seal.key-server.container` — long-running daemon. CONFIG_PATH
//     yaml is generated at start time using the published seal package
//     id + the registered KeyServer object id; mounted read-only.
//   - `instance` — the seal schema instance (a thin transformer that
//     projects the host port + keygen state into SealState).
//
// User wires: spread the returned object into stack. `seal.get(...)`
// Deps used elsewhere (in `manifest`, custom `runTransaction`s, etc.)
// resolve to the schema instance via `__pluginId`.
//
//   const sl = sealLocalnet({ signer: pool.get('signer', { name: 'publisher' }) });
//   defineDevstackConfig({
//     stack: [
//       sui.create({ network: 'localnet' }),
//       pool,
//       sl.image, sl.keygenContainer, sl.keygen,
//       sl.source, sl.publish,
//       sl.register, sl.container, sl.instance,
//     ],
//   });
export function sealLocalnet(opts: SealLocalnetOptions) {
	const version = opts.version ?? SEAL_DEFAULT_VERSION;
	const keyServerName = opts.keyServerName ?? 'devstack-local';
	const containerPort = opts.containerPort ?? DEFAULT_KEY_SERVER_CONTAINER_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

	// 1. Image — content-addressed build, or pre-built tag.
	const imageProducer =
		opts.image !== undefined
			? undefined
			: dockerImage({
					name: 'seal.image',
					context: { path: DOCKER_CONTEXT },
					args: { SEAL_TAG: version },
				});
	const imageRef = imageProducer === undefined ? (opts.image as string) : imageProducer.get('tag');

	// 2. Keygen — one-shot `seal-cli genkey` + persistence transformer.
	const keygenContainer = dockerOneShot({
		name: 'seal.keygen.container',
		runsAs: 'seal-keygen',
		image: imageRef,
		entrypoint: 'seal-cli',
		args: ['genkey'],
	});
	const keygenInnerDeps = { container: keygenContainer.get('full') };
	const keygen = define<SealKeygenState, typeof keygenProvides, typeof keygenInnerDeps>({
		name: 'seal.keygen',
		runsAs: 'seal-keygen',
		deps: keygenInnerDeps,
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

	// 3. Source + publish.
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

	// 4. Pre-allocated host port — register submits the URL to chain
	//    using this port, and the container below claims the same slot
	//    via its `ports:` config. Single source of truth.
	const sealPortDep = ports.get('allocate', { slot: SEAL_KEY_SERVER_PORT_SLOT });

	// 5. Register — on-chain KeyServer Move call. Deps directly on
	//    keygen.publicKey (not via schema!) to avoid the cycle.
	const registerDeps = {
		signer: opts.signer,
		rpc: sui.get('rpc'),
		pkg: publish.get('package'),
		publicKey: keygen.get('publicKey'),
		hostPort: sealPortDep,
	};
	const register = define<SealRegisterState, typeof registerProvides, typeof registerDeps>({
		name: 'seal.register',
		runsAs: 'publisher',
		deps: registerDeps,
		provides: registerProvides,
		start: async ({ deps }) => {
			const keyServerUrl = `http://127.0.0.1:${deps.hostPort}`;
			const pkBytes = decodeHex(deps.publicKey);
			const tx = new Transaction();
			tx.moveCall({
				target: `${deps.pkg.packageId}::key_server::create_and_transfer_v2_independent_server`,
				arguments: [
					tx.pure.string(keyServerName),
					tx.pure.string(keyServerUrl),
					tx.pure.u8(KEY_TYPE_BONEH_FRANKLIN_BLS12381),
					tx.pure.vector('u8', Array.from(pkBytes)),
				],
			});
			const client = new SuiJsonRpcClient({ url: deps.rpc.url, network: 'localnet' });
			const result = await client.signAndExecuteTransaction({
				signer: deps.signer,
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
				package: deps.pkg,
				keyServerObjectId: objectId,
				keyServerUrl,
				keyServerName,
			};
		},
	});

	// 6. Long-running key-server container. CONFIG_PATH yaml is
	//    rendered at start time using the published seal package +
	//    registered KeyServer object id; written to host fs and mounted
	//    read-only. The container joins the per-stack docker network
	//    so node_url in the yaml resolves to sui-localnet via DNS.
	const containerInnerDeps = {
		masterKey: keygen.get('masterKey'),
		pkg: publish.get('package'),
		keyServerObjectId: register.get('keyServerObjectId'),
	};
	const container = dockerContainer<typeof containerInnerDeps>({
		name: 'seal.key-server.container',
		runsAs: 'seal',
		image: imageRef,
		network: dockerNetwork.get('name'),
		deps: containerInnerDeps,
		containerEnv: ({ deps }) => ({
			CONFIG_PATH: '/etc/seal/key-server-config.yaml',
			MASTER_KEY: deps.masterKey,
			RUST_LOG: 'info',
		}),
		volumes: ({ env, deps }) => {
			const yaml = renderSealKeyServerConfig({
				sealPackageId: deps.pkg.packageId,
				keyServerObjectId: deps.keyServerObjectId,
			});
			const path = sealKeyServerConfigPath(env);
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, yaml);
			return [{ host: path, container: '/etc/seal/key-server-config.yaml' }];
		},
		ports: [{ slot: SEAL_KEY_SERVER_PORT_SLOT, containerPort }],
		readyTimeoutMs,
	});

	// 7. Schema instance — thin transformer over the pre-allocated
	//    host port + keygen state.
	const instance = seal.create({
		hostPortDep: container.get('hostPort', { slot: SEAL_KEY_SERVER_PORT_SLOT }),
		keygenDep: keygen.get('full'),
	});

	return {
		image: imageProducer,
		keygenContainer,
		keygen,
		source,
		publish,
		register,
		container,
		instance,
	};
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
