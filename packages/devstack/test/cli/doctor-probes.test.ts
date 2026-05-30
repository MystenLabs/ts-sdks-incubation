import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach } from 'vitest';

import { makeRouterProfile, type Entrypoint } from '../../src/orchestrators/router/index.ts';
import { ROUTER_CONTAINER_SPEC_VERSION } from '../../src/orchestrators/router/traefik-container.ts';
import {
	routerProfileProbe,
	type DoctorCommandRunner,
	type PortAvailabilityProbe,
} from '../../src/cli/doctor-probes.ts';
import type { ProbeOutcome } from '../../src/surfaces/cli/commands/doctor.ts';

const tempRoots: Array<string> = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const makeProfile = () => {
	const stateRoot = mkdtempSync(join(tmpdir(), 'devstack-router-doctor-'));
	tempRoots.push(stateRoot);
	return makeRouterProfile({
		userId: 'uid-501',
		dockerContextId: 'daemon:test',
		stateRoot,
		namePrefix: 'devstack-test',
	});
};

const absentDocker: DoctorCommandRunner = () => ({
	ok: false,
	err: 'Error: No such object',
});

const detailOf = (outcome: ProbeOutcome): string =>
	'detail' in outcome ? (outcome.detail ?? '') : '';

describe('routerProfileProbe', () => {
	it.effect('probes configured router entrypoint ports instead of generic 80/443', () =>
		Effect.gen(function* () {
			const profile = makeProfile();
			const entrypoints: ReadonlyArray<Entrypoint> = [
				{ name: 'wallet', port: 6173, protocol: 'http' },
				{ name: 'walrus', port: 9185, protocol: 'http' },
				{ name: 'walrus-alias', port: 9185, protocol: 'http' },
			];
			const probed: Array<number> = [];
			const probePort: PortAvailabilityProbe = (port) =>
				Promise.resolve().then(() => {
					probed.push(port);
					return true;
				});

			const outcome = yield* routerProfileProbe({
				profile,
				entrypoints,
				command: absentDocker,
				probePort,
			}).run();

			expect(outcome.status).toBe('ok');
			expect(probed).toEqual([6173, 9185]);
			expect(detailOf(outcome)).toContain('entrypoints=6173, 9185');
			expect(detailOf(outcome)).not.toContain('80');
			expect(detailOf(outcome)).not.toContain('443');
		}),
	);

	it.effect('treats corrupt dispatch files as protected unknown leases', () =>
		Effect.gen(function* () {
			const profile = makeProfile();
			mkdirSync(profile.dispatchDir, { recursive: true });
			const badRoute = join(profile.dispatchDir, '10-bad.yml');
			writeFileSync(badRoute, 'not a dispatch route');

			const outcome = yield* routerProfileProbe({
				profile,
				entrypoints: [{ name: 'wallet', port: 6173, protocol: 'http' }],
				command: absentDocker,
				probePort: () => Promise.resolve(true),
			}).run();

			expect(outcome.status).toBe('warn');
			expect(detailOf(outcome)).toContain('unknown=1');
			expect(detailOf(outcome)).toContain('corrupt=1');
			expect(detailOf(outcome)).toContain('pruneSafe=no');
			expect(detailOf(outcome)).toContain('protected dispatch leases exist');
			expect(existsSync(badRoute)).toBe(true);
		}),
	);

	it.effect('reports matching router container and network state', () =>
		Effect.gen(function* () {
			const profile = makeProfile();
			const entrypoints: ReadonlyArray<Entrypoint> = [
				{ name: 'wallet', port: 6173, protocol: 'http' },
				{ name: 'seal', port: 2024, protocol: 'http' },
			];
			const command: DoctorCommandRunner = (_cmd, args) => {
				if (args[0] === 'container' && args[1] === 'inspect') {
					return {
						ok: true,
						out: JSON.stringify([
							{
								Id: 'router-container',
								State: { Running: true },
								Config: {
									Labels: {
										'devstack.managed': 'true',
										'devstack.kind': 'router',
										'devstack.subkind': profile.id,
										'devstack.spec-version': ROUTER_CONTAINER_SPEC_VERSION,
									},
								},
								NetworkSettings: {
									Networks: { [profile.networkName]: {} },
									Ports: {
										'2024/tcp': [{ HostIp: '127.0.0.1', HostPort: '2024' }],
										'6173/tcp': [{ HostIp: '127.0.0.1', HostPort: '6173' }],
									},
								},
							},
						]),
					};
				}
				if (args[0] === 'network' && args[1] === 'inspect') {
					return { ok: true, out: JSON.stringify([{ Id: 'router-network' }]) };
				}
				return absentDocker(_cmd, args);
			};

			const outcome = yield* routerProfileProbe({
				profile,
				entrypoints,
				command,
				probePort: () => Promise.resolve(false),
			}).run();

			expect(outcome.status).toBe('ok');
			expect(detailOf(outcome)).toContain('container=running/labels=ok/network=attached');
			expect(detailOf(outcome)).toContain('network=present');
			expect(detailOf(outcome)).toContain('entrypoints=2024, 6173');
		}),
	);
});
