// Unit tests for `key-server.ts::buildKeyServerSpec` — the container
// spec the long-running key-server runs under.
//
// We test the spec-builder (a pure function) here because it pins
// load-bearing distilled-doc invariants:
//
//   - #1 (URL parity): the `routedUrl` is the SAME string used
//     downstream by the on-chain register Move call. Two consumers
//     (the spec + the register call) MUST read identical bytes; this
//     test pins that the spec just forwards the input.
//
//   - #3 (env-file, not inline -e): the container `env:` map MUST
//     NOT contain `MASTER_KEY`. The bind-mounted env-file at
//     /etc/seal/master-key.env is sourced by the entrypoint shell
//     BEFORE the daemon exec — keeping the secret off
//     `docker inspect` + host process env.
//
//   - #5 (no host-port publish): the spec's `routing[]` carries
//     the seal-key-server entrypoint; NO `ports:` field on the spec (Traefik
//     dispatches by Host: header on the shared port).
//
// Lives at `test/plugins/seal/key-server-spec.test.ts` per the
// mirror-src/ rule.

import { describe, expect, it } from 'vitest';

import {
	buildKeyServerEnsureContainerSpec,
	buildKeyServerSpec,
	CONTAINER_ENV,
	DEFAULT_KEY_SERVER_PORT,
	DEFAULT_READY_TIMEOUT_MS,
	HOST_GATEWAY_EXTRA_HOSTS,
	INSIDE_CONFIG_PATH,
	INSIDE_MASTER_KEY_ENVFILE,
	type KeyServerSpecInputs,
} from '../../../src/plugins/seal/key-server.ts';
import { SEAL_KEY_SERVER_ENDPOINT_NAME } from '../../../src/plugins/seal/routable.ts';

const SAMPLE_INPUTS: KeyServerSpecInputs = {
	name: 'seal',
	image: { digest: 'sha256:test', tag: 'seal-test:latest' },
	containerName: 'devstack-app-main-seal-seal-key-server',
	labels: {
		app: 'app',
		stack: 'main',
		plugin: 'seal',
		role: 'key-server',
	},
	suiNetwork: 'seal-seal-net',
	servicePath: '/tmp/devstack/runtime/seal/seal',
	routedHostname: 'seal.seal.app.localhost',
	routedUrl: 'http://seal.seal.app.localhost',
};

describe('buildKeyServerSpec — distilled-doc invariants', () => {
	it('forwards routedUrl byte-for-byte (invariant #1)', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		expect(spec.routedUrl).toBe(SAMPLE_INPUTS.routedUrl);
	});

	it('env map does NOT carry MASTER_KEY (invariant #3)', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		// The spec returns a constant env map; assert MASTER_KEY is
		// neither set there nor in the shared CONTAINER_ENV.
		expect('MASTER_KEY' in CONTAINER_ENV).toBe(false);
		expect(CONTAINER_ENV.CONFIG_PATH).toBe(INSIDE_CONFIG_PATH);
		expect(CONTAINER_ENV.MASTER_KEY_ENVFILE).toBe(INSIDE_MASTER_KEY_ENVFILE);
		// Sanity: master-key envfile path the spec uses for the bind-
		// mount source is under the servicePath dir (so the host file
		// the entrypoint shell sources is the rendered one).
		expect(spec.masterKeyEnvFileHostPath.startsWith(SAMPLE_INPUTS.servicePath)).toBe(true);
		expect(spec.masterKeyEnvFileHostPath.endsWith('/master-key.env')).toBe(true);
	});

	it('routing[] carries the seal-key-server entrypoint (invariant #5)', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		expect(spec.routing.length).toBe(1);
		expect(spec.routing[0]).toEqual({
			name: SEAL_KEY_SERVER_ENDPOINT_NAME,
			entrypoint: SEAL_KEY_SERVER_ENDPOINT_NAME,
			servicePort: DEFAULT_KEY_SERVER_PORT,
		});
	});

	it('ensureContainer spec adds host-gateway for in-container Sui RPC', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		const ensureSpec = buildKeyServerEnsureContainerSpec(spec);
		expect(ensureSpec.extraHosts).toEqual(HOST_GATEWAY_EXTRA_HOSTS);
		expect(ensureSpec.extraHosts).toEqual({ 'host.docker.internal': 'host-gateway' });
		expect('ports' in ensureSpec).toBe(false);
	});

	it('default ready timeout applied when omitted', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		expect(spec.readyTimeoutMs).toBe(DEFAULT_READY_TIMEOUT_MS);
	});

	it('caller-supplied ready timeout overrides default', () => {
		const spec = buildKeyServerSpec({ ...SAMPLE_INPUTS, readyTimeoutMs: 12345 });
		expect(spec.readyTimeoutMs).toBe(12345);
	});

	it('config + envfile host paths use the substrate-provided servicePath', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		expect(spec.configHostPath).toBe(`${SAMPLE_INPUTS.servicePath}/key-server-config.yaml`);
		expect(spec.masterKeyEnvFileHostPath).toBe(`${SAMPLE_INPUTS.servicePath}/master-key.env`);
	});

	it('signal-forwarding stop grace is 15s (invariant #7 — daemon needs SIGINT-forward window)', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		expect(spec.stopGraceSeconds).toBe(15);
	});

	it('container port matches the well-known seal key-server port', () => {
		const spec = buildKeyServerSpec(SAMPLE_INPUTS);
		expect(spec.containerPort).toBe(DEFAULT_KEY_SERVER_PORT);
	});
});
