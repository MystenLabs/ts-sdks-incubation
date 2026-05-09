import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { Engine } from '../engine/class.js';
import type { Dep } from '../engine/types.js';
import { accounts } from '../plugins/accounts.js';
import { sealLocalnet, type SealKeygenState, type SealRegisterState, type SealState } from '../plugins/seal.js';
import { sui } from '../plugins/sui.js';
import type { DockerContainerState, DockerOneShotState } from '../runners/index.js';
import { describeIntegration, itIntegration } from './_helpers.js';

const exec = promisify(execFile);

// End-to-end happy path for `sealLocalnet({ signer })`:
//   - sui-localnet boots (real chain).
//   - seal.image builds (binary fetch, ~30s first time).
//   - seal.keygen.container runs `seal-cli genkey`; transformer parses
//     and persists keys.
//   - publish.seal publishes the upstream `move/seal` Move package
//     against the running localnet (uses host `sui` CLI).
//   - seal.register submits `create_and_transfer_v2_independent_server`
//     using the pre-allocated host port for the on-chain URL, captures
//     the new KeyServer object id.
//   - seal.key-server.container starts with a `CONFIG_PATH` yaml
//     wired to the registered KeyServer; daemon serves HTTP.
//
// `slow:true` because the publish step waits on the host `sui` CLI to
// compile + submit the seal Move package — minutes on cold cache.

describeIntegration('sealLocalnet (publish + register + live key-server)', () => {
	itIntegration(
		'full bring-up: image build → keygen → publish → register → key-server serves HTTP',
		async ({ env, track }) => {
			const accountsBundle = accounts({ specs: { publisher: { role: 'publisher' } } });
			const signerDep = accountsBundle.pool.get('signer', {
				name: 'publisher',
			}) as unknown as Dep<unknown, import('@mysten/sui/keypairs/ed25519').Ed25519Keypair>;

			const sl = sealLocalnet({ signer: signerDep });

			const engine = new Engine(
				{
					stack: [
						sui.create({ network: 'localnet' }),
						accountsBundle.pool,
						accountsBundle.fund,
						sl.image!,
						sl.keygenContainer,
						sl.keygen,
						sl.source,
						sl.publish,
						sl.register,
						sl.container,
						sl.instance,
					],
				},
				{ env },
			);

			try {
				const result = await engine.runOnce();
				if (result.errored.length > 0) {
					const summary = result.errored
						.map((e) => `${e.name}: ${e.error.message}`)
						.join('\n');
					throw new Error(`engine cycle errored:\n${summary}`);
				}

				const view = engine.getState();

				// --- network + container tracking ----------------------
				const network = view.nodes.get('docker.network')?.state as
					| { name: string }
					| undefined;
				track.network(network?.name);
				for (const n of [
					'sui.indexer-db',
					'sui.localnet.container',
					'seal.key-server.container',
				]) {
					const s = view.nodes.get(n)?.state as DockerContainerState | undefined;
					track.container(s?.containerId);
				}

				// --- image built ---------------------------------------
				const image = view.nodes.get('seal.image')?.state as
					| { tag: string }
					| undefined;
				expect(image?.tag).toMatch(/^devstack\/seal\.image:[0-9a-f]{12}$/);

				// --- keygen ran ---------------------------------------
				const keygenContainer = view.nodes.get('seal.keygen.container')?.state as
					| DockerOneShotState
					| undefined;
				expect(keygenContainer?.exitCode).toBe(0);
				const keygen = view.nodes.get('seal.keygen')?.state as
					| SealKeygenState
					| undefined;
				expect(keygen?.masterKey).toMatch(/^(0x)?[0-9a-fA-F]+$/);
				expect(keygen?.publicKey).toMatch(/^(0x)?[0-9a-fA-F]+$/);
				const keysOnDisk = JSON.parse(
					readFileSync(
						join(env.appDir, '.devstack', 'stacks', 'main', '.keys', 'seal-master-key.json'),
						'utf8',
					),
				) as SealKeygenState;
				expect(keysOnDisk.masterKey).toBe(keygen!.masterKey);

				// --- publish + register --------------------------------
				const register = view.nodes.get('seal.register')?.state as
					| SealRegisterState
					| undefined;
				expect(register).toBeDefined();
				expect(register!.keyServerObjectId).toMatch(/^0x[0-9a-f]{64}$/);
				expect(register!.keyServerName).toBe('devstack-local');
				expect(register!.keyServerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				expect(register!.package.packageId).toMatch(/^0x[0-9a-f]{64}$/);

				// --- key-server container is alive --------------------
				const ks = view.nodes.get('seal.key-server.container')?.state as
					| DockerContainerState
					| undefined;
				expect(ks).toBeDefined();
				expect(ks!.network).toBe(network!.name);
				const yamlPath = join(
					env.appDir,
					'.devstack',
					'stacks',
					'main',
					'.generated',
					'seal-key-server-config.yaml',
				);
				expect(existsSync(yamlPath)).toBe(true);
				const yaml = readFileSync(yamlPath, 'utf8');
				expect(yaml).toContain(`seal_package: '${register!.package.packageId}'`);
				expect(yaml).toContain(`key_server_object_id: '${register!.keyServerObjectId}'`);
				expect(yaml).toContain('node_url: http://sui-localnet:9000');

				// --- schema instance state ----------------------------
				const sealState = view.nodes.get('seal.key-server')?.state as
					| SealState
					| undefined;
				expect(sealState?.url).toBe(register!.keyServerUrl);
				expect(sealState?.managed).toBe(true);
				expect(sealState?.publicKey).toBe(keygen!.publicKey);

				// --- daemon serves HTTP -------------------------------
				// `/v1/service?service_id=<obj>` is the Open-mode probe
				// the upstream healthcheck uses. The daemon takes a few
				// seconds after start to load its KeyServer object via
				// chain RPC; poll until 2xx or timeout.
				const probeOk = await pollKeyServer(
					sealState!.url,
					register!.keyServerObjectId,
					90_000,
				);
				if (!probeOk.ok) {
					const logs = await exec('docker', ['logs', '--tail', '120', ks!.containerId])
						.then((r) => `${r.stdout}\n${r.stderr}`)
						.catch(() => '<docker logs failed>');
					throw new Error(
						`seal key-server did not respond at ${sealState!.url} (${probeOk.detail});\nlogs:\n${logs}`,
					);
				}
			} finally {
				await engine.stop();
			}
		},
		{ slow: true },
	);
});

interface ProbeResult {
	ok: boolean;
	detail?: string;
}

// Hits the upstream Open-mode `/v1/service` endpoint with the
// version-validation headers the daemon's middleware enforces.
async function pollKeyServer(
	baseUrl: string,
	keyServerObjectId: string,
	timeoutMs: number,
): Promise<ProbeResult> {
	const url = `${baseUrl}/v1/service?service_id=${keyServerObjectId}`;
	const deadline = Date.now() + timeoutMs;
	let lastErr: string | undefined;
	while (Date.now() < deadline) {
		try {
			await exec('curl', [
				'-sf',
				'--max-time',
				'2',
				'-H',
				'Client-Sdk-Type: typescript',
				'-H',
				'Client-Sdk-Version: 0.4.18',
				'-H',
				'Request-Id: integration-probe',
				url,
			]);
			return { ok: true };
		} catch (err) {
			lastErr = (err as Error).message.split('\n')[0]?.slice(0, 200);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	return { ok: false, detail: lastErr ?? 'timed out' };
}
