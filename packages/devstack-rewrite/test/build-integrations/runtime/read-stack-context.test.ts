// `readStackContext` — sync manifest reader + projection tests.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';

import {
	ManifestDiscoveryError,
	ManifestShapeError,
	readStackContext,
	CONSUMER_MANIFEST_VERSION,
} from '../../../src/build-integrations/runtime/index.ts';
import { buildEnvelope, writeManifest } from '../../../src/substrate/runtime/manifest/index.ts';

const makeManifestAt = (path: string, body: object): void => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, JSON.stringify(body, null, 2));
};

const validEnvelope = (overrides: Partial<Record<string, unknown>> = {}): object => ({
	identity: { app: 'demo', stack: 'main', chain: 'sui:local' },
	manifestVersion: CONSUMER_MANIFEST_VERSION,
	services: {
		'router/main': { hostnameSuffix: '.localhost' },
	},
	endpoints: {
		'sui-rpc': {
			url: 'http://sui-rpc.demo.localhost:5174',
			displayUrl: 'http://sui-rpc.demo.localhost:5174',
			wireProtocol: 'http',
			pluginKey: 'sui/main',
			endpointKey: 'sui-rpc-key',
		},
	},
	extras: {},
	...overrides,
});

describe('readStackContext (sync)', () => {
	it('projects identity, endpoints, services, extras', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
		const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		makeManifestAt(manifestPath, validEnvelope());
		const ctx = readStackContext({ manifestPath });
		expect(ctx.identity).toEqual({ app: 'demo', stack: 'main', chain: 'sui:local' });
		expect(ctx.manifestPath).toBe(manifestPath);
		expect(ctx.manifestVersion).toBe(CONSUMER_MANIFEST_VERSION);
		const rpc = ctx.endpoints.byName('sui-rpc');
		expect(rpc).toBeDefined();
		expect(rpc?.url).toBe('http://sui-rpc.demo.localhost:5174');
		expect(rpc?.wireProtocol).toBe('http');
	});

	it.effect('round-trips app extras through the manifest writer and runtime reader', () =>
		Effect.gen(function* () {
			const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
			const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
			const extras = {
				openLobbyId: '0xfeed',
				sealKeyServer: {
					objectId: '0xseal',
					url: 'http://seal.localhost:5175',
				},
			};
			const envelope = yield* buildEnvelope({
				identity: { app: 'demo', stack: 'main', chain: 'sui:local' },
				contributions: [],
				extras,
			});
			yield* writeManifest(envelope, manifestPath);

			const ctx = readStackContext({ manifestPath });
			expect(ctx.extras).toEqual(extras);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it('walks up from a nested cwd to find the manifest', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
		const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		makeManifestAt(manifestPath, validEnvelope());
		const nested = join(tmp, 'a', 'b');
		mkdirSync(nested, { recursive: true });
		const ctx = readStackContext({ cwd: nested });
		expect(ctx.manifestPath).toBe(manifestPath);
	});

	it('throws ManifestShapeError(phase=parse) on corrupt JSON', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
		const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		mkdirSync(join(manifestPath, '..'), { recursive: true });
		writeFileSync(manifestPath, '{not json');
		try {
			readStackContext({ manifestPath });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestShapeError);
			expect((err as ManifestShapeError).phase).toBe('parse');
		}
	});

	it('throws ManifestShapeError(phase=shape) on wrong envelope shape', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
		const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		makeManifestAt(manifestPath, { totally: 'wrong shape' });
		try {
			readStackContext({ manifestPath });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestShapeError);
			expect((err as ManifestShapeError).phase).toBe('shape');
		}
	});

	it('throws ManifestShapeError(phase=version) on version mismatch', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
		const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
		makeManifestAt(manifestPath, validEnvelope({ manifestVersion: 999 }));
		try {
			readStackContext({ manifestPath });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestShapeError);
			expect((err as ManifestShapeError).phase).toBe('version');
		}
	});

	it('throws ManifestDiscoveryError when no manifest exists', () => {
		const tmp = mkdtempSync(join(tmpdir(), 'devstack-read-'));
		try {
			readStackContext({ cwd: tmp, stateDir: '.devstack-missing-sentinel' });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ManifestDiscoveryError);
		}
	});
});
