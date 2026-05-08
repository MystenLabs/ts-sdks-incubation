// Seal key-server plugin. Owns four actions:
//
//   seal.build       — Multi-arch build of `mysten-devstack/seal:<version>` (image
//                      bundles `key-server` + `seal-cli`).
//   seal.publish     — Publish the upstream `move/seal` package against the
//                      sui-localnet container (M8 source-digest + on-chain
//                      liveness gate via `publishMovePackage`).
//   seal.register    — One-shot bootstrap: cache a BLS12-381 master key on
//                      disk, then register a `KeyServer` object on-chain via
//                      `seal::key_server::create_and_transfer_v2_independent_server`.
//                      `getStatus()` checks the cached object is still live on
//                      chain so warm `up` cycles skip the ~12s re-registration.
//   seal.key-server  — Long-running container in Open mode (single key
//                      server, no committee). Healthcheck via
//                      `/v1/service?service_id=<id>` + version validation
//                      headers the upstream middleware demands. Joins the
//                      per-app docker network so it can reach `sui-localnet`.
//
// Linear actions: publish → register → key-server, gated by the reconciler.
// The frontend `SealClient` reads `keyServerObjectId` + `keyServerUrl` out
// of the manifest's `seal.keyServer` namespace.
//
// `node:*` modules load via top-level `await import(...)` so the static
// surface stays browser-safe — see `runtime/hash.ts` for rationale.

import { Transaction } from '@mysten/sui/transactions';

import { buildImage } from '../../actions/build.js';
import { containerService } from '../../actions/container-service.js';
import { publish } from '../../actions/publish.js';
import { register } from '../../actions/register.js';
import type {
	ActionRunContext,
	LocalnetActionRunContext,
	Plugin,
} from '../../core/types.js';
import { pollUntilReady } from '../../helpers/poll.js';
import { openSuiRpcClient } from '../../helpers/sui-client.js';
import { extractUpstreamSource } from '../../helpers/upstream-source.js';
import { definePlugin } from '../../plugin.js';
import { defineRegistryKind } from '../../registry/index.js';
import { stackDir } from '../../runtime/active-stack.js';
import { requireLocalnetCtx } from '../../runtime/runtime-helpers.js';
import {
	appNetworkName,
	devstackContainerLabels,
	hostDockerPlatform,
	imageExists,
} from '../../runtime/docker/index.js';
import { dockerRun } from '../../runtime/docker/run.js';
import {
	SEAL_IMAGE_MOVE_PACKAGE_PATH,
	SEAL_SDK_VERSION,
	SEAL_VERSION,
	ensureSealImage,
	sealImageTag,
} from './build.js';

const [nodeFs, nodeOs, nodePath] = await Promise.all([
	import('node:fs'),
	import('node:os'),
	import('node:path'),
]);

const KEY_SERVER_CONTAINER_PORT = 2024;
const SEAL_KEY_SERVER_NAME = 'devstack-local';
/** Boneh-Franklin BLS12-381 — the only `KEY_TYPE` accepted by upstream
 * (`seal/move/seal/sources/key_server.move`). */
const KEY_TYPE_BONEH_FRANKLIN_BLS12381 = 0;

const keyServerContainerName = (appName: string, stack: string): string =>
	`${appName}-${stack}-seal-key-server`;
const masterKeyPath = (appDir: string, stack: string): string =>
	nodePath.join(stackDir(appDir, stack), '.keys', 'seal-master-key.json');
const sealConfigPath = (appDir: string, stack: string): string =>
	nodePath.join(stackDir(appDir, stack), '.generated', 'seal-config.yaml');

/** Frontend-facing `seal.keyServer` registry record. The manifest writer
 * round-trips it under `seal.keyServer` so dapps can read it via the
 * registry namespace. */
interface SealKeyServer {
	name: string;
	objectId: string;
	url: string;
	sealPackageId: string;
}

const sealKeyServers = defineRegistryKind<SealKeyServer>('seal.keyServer');

interface SealPluginOptions {
	/** Pinned seal release tag (e.g. `'seal-v0.6.6'`). Defaults to the
	 * version tracked in `build.ts`. Used both to pull the matching
	 * `seal-cli` + `key-server` binaries from the GitHub release AND as
	 * the git ref BuildKit fetches the `move/seal` Move package source
	 * from for the publish path. */
	version?: string;
	/** Host port the key-server's HTTP API binds on. Frontend `SealClient`
	 * talks to this URL. Default `2024`. */
	port?: number;
	/** On-chain `KeyServer.name` field + registry record key. Default
	 * `devstack-local`. Overriding lets two stacks on one host point at
	 * distinct on-chain `KeyServer` objects without colliding on the
	 * registry key. */
	keyServerName?: string;
	/** Account that signs the `KeyServer` registration tx. Defaults to
	 * `'publisher'` to match the rest of the built-ins. */
	publisher?: string;
}

export const seal = (
	opts: SealPluginOptions = {},
): Plugin<'seal.build' | 'seal.publish' | 'seal.register' | 'seal.key-server'> => {
	const version = opts.version ?? SEAL_VERSION;
	const preferredPort = opts.port ?? KEY_SERVER_CONTAINER_PORT;
	const keyServerName = opts.keyServerName ?? SEAL_KEY_SERVER_NAME;
	const publisherAccount = opts.publisher ?? 'publisher';
	const imageTag = sealImageTag(version);
	const platform = hostDockerPlatform();

	const resolveEndpoint = async (ctx: {
		ports: import('../../core/types.js').PortAllocator;
	}): Promise<{ port: number; keyServerUrl: string }> => {
		const [portValue] = await ctx.ports.allocate({
			slot: 'seal.key-server',
			preferred: preferredPort,
		});
		if (portValue === undefined) throw new Error('seal: port allocator returned no ports');
		return { port: portValue, keyServerUrl: `http://127.0.0.1:${portValue}` };
	};

	return definePlugin({
		name: 'seal',
		// Folded into the snapshot id. `imageTag` covers `version` +
		// `platform` (the build action's input) so bumping any of those
		// re-derives a fresh id; the master key on disk is captured
		// separately via the host-fs portion of the snapshot.
		inputs: { image: imageTag, version },
		provides: ['seal.build', 'seal.publish', 'seal.register', 'seal.key-server'],
		actions: () => [
			buildImage({
				name: 'build',
				inputs: { image: imageTag, version, platform },
				getStatus: async () =>
					(await imageExists(imageTag))
						? { ok: true, detail: imageTag }
						: { ok: false, detail: `image ${imageTag} missing` },
				run: async (ctx) => {
					await ensureSealImage({ version, appendLog: ctx.appendLog });
				},
			}),

			publish({
				name: 'publish',
				needs: ['build', 'accounts.fund'],
				registryAs: 'seal',
				publisher: publisherAccount,
				// Move sources are baked into the seal image; `path` here is
				// a stable label (the image tag) used for input hashing
				// only — the actual directory comes from `prepareSource`.
				path: imageTag,
				prepareSource: async (ctx) => {
					await ensureSealImage({ version, appendLog: ctx.appendLog });
					const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'devstack-seal-publish-'));
					await extractUpstreamSource({
						imageTag,
						srcPath: SEAL_IMAGE_MOVE_PACKAGE_PATH,
						destDir: tmpDir,
					});
					return {
						dir: tmpDir,
						cleanup: () => nodeFs.rmSync(tmpDir, { recursive: true, force: true }),
					};
				},
			}),

			register({
				name: 'register',
				needs: ['publish', 'build'],
				runsAs: publisherAccount,
				inputs: { preferredPort, keyServerName, version, publisher: publisherAccount },
				// Reconciler invokes this on every successful path (cold run +
				// warm-path skip), so the in-memory `services` registry stays
				// populated without `getStatus` having to re-register manually.
				provides: {
					registry: async (ctx) => {
						requireLocalnetCtx(ctx, 'seal.register');
						const { port } = await resolveEndpoint(ctx);
						registerKeyServerService(ctx, port);
					},
				},
				getStatus: async (ctx) => {
					const cached = sealKeyServers(ctx.registry).find(keyServerName);
					if (cached === undefined) return { ok: false, detail: 'no cached KeyServer' };
					const sealPkg = ctx.registry.packages.find('seal');
					if (sealPkg === undefined) return { ok: false, detail: 'seal package not registered' };
					if (cached.sealPackageId !== sealPkg.packageId) {
						return { ok: false, detail: 'cached KeyServer references a stale seal package' };
					}
					requireLocalnetCtx(ctx, 'seal.register');
					const { keyServerUrl } = await resolveEndpoint(ctx);
					if (cached.url !== keyServerUrl) {
						return { ok: false, detail: 'cached KeyServer URL differs from allocated port' };
					}
					const client = openSuiRpcClient(ctx);
					const live = await client.getObject({ id: cached.objectId });
					if (live.data === null || live.data === undefined) {
						return { ok: false, detail: `KeyServer ${cached.objectId} not on chain` };
					}
					return { ok: true, detail: cached.objectId };
				},
				run: async (ctx) => {
					requireLocalnetCtx(ctx, 'seal.register');
					const { keyServerUrl } = await resolveEndpoint(ctx);
					await registerSealKeyServer({
						ctx,
						imageTag,
						keyServerUrl,
						keyServerName,
						publisher: publisherAccount,
					});
				},
				/** Identity = the on-chain KeyServer object id. Cascades
				 * `seal.key-server` (the docker-side key server) when we
				 * register a fresh KeyServer (regenesis re-publish path). */
				identity: async (ctx) =>
					sealKeyServers(ctx.registry).find(keyServerName)?.objectId,
			}),

			containerService({
				name: 'key-server',
				needs: ['register'],
				inputs: { image: imageTag, preferredPort },
				// See `register` above — same warm-path rehydrate pattern.
				provides: {
					registry: async (ctx) => {
						const { port } = await resolveEndpoint(ctx);
						registerKeyServerService(ctx, port);
					},
				},
				containerName: (ctx) => keyServerContainerName(ctx.appName, ctx.stack),
				// Stateless: master key in env (from <stackDir>/.keys),
				// on-chain KeyServer in sui chain (captured via sui's commit).
				// Nothing in its writable layer worth committing.
				snapshot: { commit: false, quiesce: 'none' },
				healthyTimeoutMs: 3 * 60_000,
				spec: async (ctx) => {
					const { port } = await resolveEndpoint(ctx);
					const cached = sealKeyServers(ctx.registry).require(keyServerName);
					return {
						name: '',
						image: imageTag,
						platform,
						network: appNetworkName(ctx.appName, ctx.stack),
						hostname: 'seal-key-server',
						restart: 'unless-stopped',
						ports: [{ host: port, container: KEY_SERVER_CONTAINER_PORT }],
						labels: devstackContainerLabels({
							appName: ctx.appName,
							stack: ctx.stack,
							service: 'seal-key-server',
						}),
						env: {
							// CONFIG_PATH-based config (env-only mode silently routes at the public
							// devnet fullnode — must use a file to point at our localnet).
							CONFIG_PATH: '/etc/seal/key-server-config.yaml',
							MASTER_KEY: readMasterKey(ctx.appDir, ctx.stack),
							PORT: String(KEY_SERVER_CONTAINER_PORT),
							RUST_LOG: 'info',
						},
						volumes: [
							`${sealConfigPath(ctx.appDir, ctx.stack)}:/etc/seal/key-server-config.yaml:ro`,
						],
						healthcheck: {
							// `/v1/service?service_id=<id>` round-trips through the on-chain
							// registration cache and returns 200 once the key-server has loaded
							// our KeyServer object and minted a proof-of-possession. The
							// version-validation middleware demands these headers — any other
							// endpoint requires a signed session payload.
							test: [
								'CMD-SHELL',
								[
									"curl -sf -H 'Client-Sdk-Type: typescript'",
									`-H 'Client-Sdk-Version: ${SEAL_SDK_VERSION}'`,
									'-H "Request-Id: $(cat /proc/sys/kernel/random/uuid)"',
									`'http://localhost:${KEY_SERVER_CONTAINER_PORT}/v1/service?service_id=${cached.objectId}'`,
									'> /dev/null || exit 1',
								].join(' '),
							],
							intervalSeconds: 5,
							timeoutSeconds: 5,
							retries: 30,
							startPeriodSeconds: 10,
						},
					};
				},
			}),
		],
	});
};

interface RegisterSealOptions {
	ctx: LocalnetActionRunContext;
	imageTag: string;
	keyServerUrl: string;
	keyServerName: string;
	publisher: string;
}

async function registerSealKeyServer({
	ctx,
	imageTag,
	keyServerUrl,
	keyServerName,
	publisher: publisherAccount,
}: RegisterSealOptions): Promise<void> {
	const sealPkg = ctx.registry.packages.require('seal');
	const publisher = ctx.accounts.get(publisherAccount);
	const client = openSuiRpcClient(ctx);

	const keys = await ensureSealMasterKey({
		imageTag,
		appDir: ctx.appDir,
		stack: ctx.stack,
	});
	const pkBytes = decodePrefixedHex(keys.publicKey);

	// Wait for the just-published seal package to be visible to sui's
	// transaction-input-object check. `publishMovePackage` already
	// waits for the publish tx's finality, but on a fresh chain there's
	// a brief window where the new packageId hasn't propagated to the
	// resolver — submitting a tx that calls into the package fails
	// fast with `Error checking transaction input objects: Dependent
	// package not found on-chain: 0x…`. Poll the object directly until
	// it resolves.
	await pollUntilReady(ctx, {
		label: `seal package ${sealPkg.packageId.slice(0, 10)}…`,
		probe: async () => {
			try {
				await client.core.getObject({ objectId: sealPkg.packageId });
				return { ok: true };
			} catch (err) {
				return { ok: false, detail: String(err).split('\n')[0]?.slice(0, 120) ?? 'unknown' };
			}
		},
		timeoutMs: 30_000,
		intervalMs: 250,
		progressIntervalMs: 5_000,
	});

	const tx = new Transaction();
	tx.moveCall({
		target: `${sealPkg.packageId}::key_server::create_and_transfer_v2_independent_server`,
		arguments: [
			tx.pure.string(keyServerName),
			tx.pure.string(keyServerUrl),
			tx.pure.u8(KEY_TYPE_BONEH_FRANKLIN_BLS12381),
			tx.pure.vector('u8', Array.from(pkBytes)),
		],
	});

	const result = await client.signAndExecuteTransaction({
		signer: publisher,
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
		(c) =>
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

	writeSealConfigYaml({
		appDir: ctx.appDir,
		stack: ctx.stack,
		sealPackageId: sealPkg.packageId,
		keyServerObjectId: objectId,
	});

	sealKeyServers(ctx.registry).register({
		name: keyServerName,
		objectId,
		url: keyServerUrl,
		sealPackageId: sealPkg.packageId,
	});
}

interface CachedKeys {
	masterKey: string;
	publicKey: string;
}

async function ensureSealMasterKey(opts: {
	imageTag: string;
	appDir: string;
	stack: string;
}): Promise<CachedKeys> {
	const path = masterKeyPath(opts.appDir, opts.stack);
	const cached = readMasterKeyFile(path);
	if (cached !== null) return cached;

	const result = await dockerRun({
		command: ['run', '--rm', '--entrypoint', 'seal-cli', opts.imageTag, 'genkey'],
	});
	if (result.code !== 0) {
		throw new Error(`seal.register: seal-cli genkey failed:\n${result.stderr}`);
	}
	const masterMatch = result.stdout.match(/^Master key:\s*(\S+)/m);
	const publicMatch = result.stdout.match(/^Public key:\s*(\S+)/m);
	if (masterMatch?.[1] === undefined || publicMatch?.[1] === undefined) {
		throw new Error(`seal.register: failed to parse seal-cli genkey output:\n${result.stdout}`);
	}
	const keys: CachedKeys = { masterKey: masterMatch[1], publicKey: publicMatch[1] };

	nodeFs.mkdirSync(nodePath.join(stackDir(opts.appDir, opts.stack), '.keys'), { recursive: true, mode: 0o700 });
	nodeFs.writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
	return keys;
}

function readMasterKeyFile(path: string): CachedKeys | null {
	if (!nodeFs.existsSync(path)) return null;
	const parsed = JSON.parse(nodeFs.readFileSync(path, 'utf8')) as Partial<CachedKeys>;
	if (typeof parsed.masterKey !== 'string' || typeof parsed.publicKey !== 'string') return null;
	return { masterKey: parsed.masterKey, publicKey: parsed.publicKey };
}

function readMasterKey(appDir: string, stack: string): string {
	const parsed = JSON.parse(nodeFs.readFileSync(masterKeyPath(appDir, stack), 'utf8')) as CachedKeys;
	return parsed.masterKey;
}

function writeSealConfigYaml(opts: {
	appDir: string;
	stack: string;
	sealPackageId: string;
	keyServerObjectId: string;
}): void {
	const path = sealConfigPath(opts.appDir, opts.stack);
	const yaml = [
		`# Generated by devstack seal plugin at ${new Date().toISOString()}.`,
		'# CONFIG_PATH-based config — env-only mode silently ignores NODE_URL,',
		'# which routes the key-server at the public devnet fullnode by default.',
		'network: !Devnet',
		`  seal_package: '${opts.sealPackageId}'`,
		'node_url: http://sui-localnet:9000',
		'server_mode: !Open',
		`  key_server_object_id: '${opts.keyServerObjectId}'`,
		`ts_sdk_version_requirement: '>=0.4.5'`,
		'',
	].join('\n');
	nodeFs.mkdirSync(nodePath.join(stackDir(opts.appDir, opts.stack), '.generated'), { recursive: true });
	nodeFs.writeFileSync(path, yaml);
}

/** Shared `provides.registry` hook for both `seal.register` and
 * `seal.key-server`. Reconciler invokes this on every successful path —
 * cold run completion AND warm-path skips — so the in-memory `services`
 * registry is populated even when neither action's `run` body executed
 * this cycle. Idempotent: `services.register` overwrites by name. */
function registerKeyServerService(ctx: ActionRunContext, port: number): void {
	ctx.registry.services.register({
		name: 'seal-key-server',
		kind: 'seal-key-server',
		url: `http://127.0.0.1:${port}`,
		port: port,
		endpointLabel: 'Seal key-server (Open mode)',
	});
}

function decodePrefixedHex(s: string): Uint8Array {
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
