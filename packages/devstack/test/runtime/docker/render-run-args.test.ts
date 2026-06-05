// `renderRunArgs` / `renderCreateArgs` — pure argv shape tests.
//
// These exercise the per-flag emit order that is load-bearing for
// byte-identical migration: consumer fake-docker tests assert the
// exact argv string `docker` saw, so any reordering breaks them.

import { describe, expect, it } from 'vitest';

import { renderCreateArgs, renderRunArgs } from '../../../src/runtime/docker/render-run-args.ts';

describe('renderRunArgs', () => {
	it('emits `--rm --name` for the empty-flag base case', () => {
		expect(renderRunArgs({ name: 'oneshot', image: 'alpine:3.20' })).toEqual([
			'--rm',
			'--name',
			'oneshot',
			'alpine:3.20',
		]);
	});

	it('drops `--rm` when keep:true (forensic-retention escape hatch)', () => {
		expect(renderRunArgs({ keep: true, name: 'oneshot', image: 'alpine:3.20' })).toEqual([
			'--name',
			'oneshot',
			'alpine:3.20',
		]);
	});

	it('flattens env into `--env K=V` per entry, preserving key order', () => {
		expect(
			renderRunArgs({
				name: 'oneshot',
				image: 'alpine:3.20',
				env: { FOO: '1', BAR: '2' },
			}),
		).toEqual(['--rm', '--name', 'oneshot', '--env', 'FOO=1', '--env', 'BAR=2', 'alpine:3.20']);
	});

	it('flattens mounts into `--mount type=bind,…[,readonly]`', () => {
		expect(
			renderRunArgs({
				name: 'oneshot',
				image: 'alpine:3.20',
				mounts: [
					{ source: '/host/rw', target: '/in/rw' },
					{ source: '/host/ro', target: '/in/ro', readonly: true },
				],
			}),
		).toEqual([
			'--rm',
			'--name',
			'oneshot',
			'--mount',
			'type=bind,source=/host/rw,target=/in/rw',
			'--mount',
			'type=bind,source=/host/ro,target=/in/ro,readonly',
			'alpine:3.20',
		]);
	});

	it('emits the all-flags one-shot in the documented order', () => {
		expect(
			renderRunArgs({
				name: 'devstack-oneshot',
				image: 'walrus:test',
				argv: ['-c', 'echo hi'],
				network: 'devstack-net',
				entrypoint: 'sh',
				user: '1234:5678',
				env: { FOO: 'bar' },
				mounts: [{ source: '/h', target: '/c' }],
				labels: ['app=devstack', 'kind=oneshot'],
				addHosts: { 'host.docker.internal': 'host-gateway' },
			}),
		).toEqual([
			'--rm',
			'--name',
			'devstack-oneshot',
			'--network',
			'devstack-net',
			'--entrypoint',
			'sh',
			'--user',
			'1234:5678',
			'--env',
			'FOO=bar',
			'--mount',
			'type=bind,source=/h,target=/c',
			'--label',
			'app=devstack',
			'--label',
			'kind=oneshot',
			'--add-host',
			'host.docker.internal:host-gateway',
			'walrus:test',
			'-c',
			'echo hi',
		]);
	});
});

describe('renderCreateArgs', () => {
	it('emits the minimal `-d --name <image>` base case', () => {
		expect(renderCreateArgs({ name: 'sui', image: 'sui:test' })).toEqual([
			'-d',
			'--name',
			'sui',
			'sui:test',
		]);
	});

	it('emits ports via short-form `-p` with optional host IP prefix', () => {
		expect(
			renderCreateArgs({
				name: 'sui',
				image: 'sui:test',
				ports: [
					{ containerPort: 9000, hostPort: 9000 },
					{ containerPort: 9001, hostPort: 19001, hostIp: '127.0.0.1' },
				],
			}),
		).toEqual(['-d', '--name', 'sui', '-p', '9000:9000', '-p', '127.0.0.1:19001:9001', 'sui:test']);
	});

	it('emits the first network attach with per-network aliases', () => {
		expect(
			renderCreateArgs({
				name: 'sui',
				image: 'sui:test',
				network: { name: 'devstack-net', aliases: ['sui-rpc', 'sui-internal'] },
			}),
		).toEqual([
			'-d',
			'--name',
			'sui',
			'--network',
			'devstack-net',
			'--network-alias',
			'sui-rpc',
			'--network-alias',
			'sui-internal',
			'sui:test',
		]);
	});

	it('emits the all-flags create in the documented order', () => {
		expect(
			renderCreateArgs({
				name: 'sui',
				image: 'sui:test',
				labels: ['app.devstack/managed=true', 'app.devstack/stack=demo'],
				env: { RUST_LOG: 'debug' },
				ports: [{ containerPort: 9000, hostPort: 9000 }],
				mounts: [{ source: '/var/sui', target: '/data', readonly: false }],
				network: { name: 'devstack-net' },
				addHosts: { 'host.docker.internal': 'host-gateway' },
				entrypoint: 'sui-node',
				command: ['--config', '/etc/sui/cfg.yaml'],
			}),
		).toEqual([
			'-d',
			'--name',
			'sui',
			'--label',
			'app.devstack/managed=true',
			'--label',
			'app.devstack/stack=demo',
			'--env',
			'RUST_LOG=debug',
			'-p',
			'9000:9000',
			'--mount',
			'type=bind,source=/var/sui,target=/data',
			'--network',
			'devstack-net',
			'--add-host',
			'host.docker.internal:host-gateway',
			'--entrypoint',
			'sui-node',
			'sui:test',
			'--config',
			'/etc/sui/cfg.yaml',
		]);
	});
});
