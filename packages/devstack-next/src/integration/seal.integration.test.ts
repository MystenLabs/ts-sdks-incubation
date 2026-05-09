import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { Engine } from '../engine/class.js';
import { seal, type SealKeygenState, type SealState } from '../plugins/seal.js';
import type { DockerContainerState, DockerOneShotState } from '../runners/index.js';
import { describeIntegration, itIntegration } from './_helpers.js';

// End-to-end happy path for `seal.create({})`'s docker bring-up:
//   - seal.image builds (binary fetch from the seal release — no rust
//     compile, ~30s on first build, instant when cached).
//   - seal.keygen.container runs `seal-cli genkey`; transformer parses
//     and persists the master + public keys to
//     `<stackDir>/.keys/seal-master-key.json` (mode 0600).
//   - seal.key-server.container boots with `MASTER_KEY` from the
//     transformer.
//   - SealState carries `masterKey` + `publicKey` (managed-mode only)
//     so `seal.get('publicKey')` is consumable downstream by
//     `sealLocalnet`.
//
// We don't probe the key-server's HTTP endpoints — the daemon needs a
// `CONFIG_PATH` yaml pointing at a real sui chain + a registered
// `KeyServer` object id to actually serve requests. That's the
// `sealLocalnet({ signer })` flow's job (publish + register + write
// the yaml). Future enhancement: a combined sui+seal integration test
// that exercises `sealLocalnet`'s register step end-to-end.

describeIntegration('seal (managed-mode end-to-end)', () => {
	itIntegration(
		'builds the image, runs keygen, brings up the key-server with the parsed master key',
		async ({ env, track }) => {
			const node = seal.create({});
			const engine = new Engine({ stack: [node] }, { env });

			try {
				const result = await engine.runOnce();
				expect(result.errored).toEqual([]);

				const view = engine.getState();

				// --- image build -----------------------------------------
				const imageState = view.nodes.get('seal.image')?.state as
					| { tag: string }
					| undefined;
				expect(imageState).toBeDefined();
				expect(imageState!.tag).toMatch(/^devstack\/seal\.image:[0-9a-f]{12}$/);

				// --- keygen one-shot -------------------------------------
				const keygenContainer = view.nodes.get('seal.keygen.container')?.state as
					| DockerOneShotState
					| undefined;
				expect(keygenContainer).toBeDefined();
				expect(keygenContainer!.exitCode).toBe(0);
				expect(keygenContainer!.tail).toContain('Master key:');
				expect(keygenContainer!.tail).toContain('Public key:');

				// --- keygen transformer ----------------------------------
				const keygen = view.nodes.get('seal.keygen')?.state as
					| SealKeygenState
					| undefined;
				expect(keygen).toBeDefined();
				expect(keygen!.masterKey).toMatch(/^(0x)?[0-9a-fA-F]+$/);
				expect(keygen!.publicKey).toMatch(/^(0x)?[0-9a-fA-F]+$/);
				expect(keygen!.generatedAt).toBeGreaterThan(0);

				// --- on-disk cache ---------------------------------------
				const keysPath = join(
					env.appDir,
					'.devstack',
					'stacks',
					'main',
					'.keys',
					'seal-master-key.json',
				);
				expect(existsSync(keysPath)).toBe(true);
				const cached = JSON.parse(readFileSync(keysPath, 'utf8')) as SealKeygenState;
				expect(cached.masterKey).toBe(keygen!.masterKey);
				expect(cached.publicKey).toBe(keygen!.publicKey);

				// --- key-server container --------------------------------
				const keyServer = view.nodes.get('seal.key-server.container')?.state as
					| DockerContainerState
					| undefined;
				expect(keyServer).toBeDefined();
				track.container(keyServer!.containerId);
				expect(keyServer!.hostPorts['seal.key-server']).toBeGreaterThan(0);

				// --- transformer state -----------------------------------
				const sealState = view.nodes.get('seal.key-server')?.state as
					| SealState
					| undefined;
				expect(sealState).toBeDefined();
				expect(sealState!.managed).toBe(true);
				expect(sealState!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				expect(sealState!.masterKey).toBe(keygen!.masterKey);
				expect(sealState!.publicKey).toBe(keygen!.publicKey);

				// --- container reached the spawned state -----------------
				// We don't assert the container is *running* — without
				// a `CONFIG_PATH` yaml the key-server binary exits
				// shortly after start (it can't reach sui-localnet's
				// chain at startup to fetch its KeyServer metadata).
				// That's a known limitation of standalone managed mode;
				// see top-of-file comment on what `sealLocalnet` does
				// to make the daemon actually usable.
				const containerExists = execFileSync(
					'docker',
					[
						'inspect',
						'-f',
						'{{.Id}}',
						keyServer!.containerId,
					],
					{ encoding: 'utf8' },
				).trim();
				expect(containerExists.startsWith(keyServer!.containerId.slice(0, 12))).toBe(true);
			} finally {
				await engine.stop();
			}
		},
	);
});
