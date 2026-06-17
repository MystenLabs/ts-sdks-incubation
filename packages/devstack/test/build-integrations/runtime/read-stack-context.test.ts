// `readStackContext` — sync manifest reader + projection tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect } from 'effect';

import {
	ManifestDiscoveryError,
	ManifestShapeError,
	readStackContext,
	CONSUMER_MANIFEST_VERSION,
	manifestEnvelopeFromStackContext,
} from '../../../src/build-integrations/runtime/index.ts';
import { buildEnvelope, writeManifest } from '../../../src/substrate/runtime/manifest/index.ts';
import { withTempRoot, withTempRootSync } from '../../helpers/with-temp-root.ts';

const makeManifestAt = (path: string, body: object): void => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, JSON.stringify(body, null, 2));
};

// No `services` slot. Omitting it exercises the optional-decode +
// `ctx.services ?? {}` default path.
const validEnvelope = (overrides: Partial<Record<string, unknown>> = {}): object => ({
	identity: { app: 'demo', stack: 'main', network: 'localnet' },
	manifestVersion: CONSUMER_MANIFEST_VERSION,
	endpoints: {
		'sui#0:rpc': {
			name: 'rpc',
			url: 'http://sui-rpc.demo.localhost:5174',
			displayUrl: 'http://sui-rpc.demo.localhost:5174',
			wireProtocol: 'http',
			pluginKey: 'sui/main',
			endpointKey: 'sui#0:rpc',
		},
	},
	extras: {},
	...overrides,
});

describe('readStackContext (sync)', () => {
	it('projects identity, endpoints, extras (services defaults to {} when omitted)', () =>
		withTempRootSync('devstack-read', (tmp) => {
			const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
			makeManifestAt(manifestPath, validEnvelope());
			const ctx = readStackContext({ manifestPath });
			expect(ctx.identity).toEqual({ app: 'demo', stack: 'main', network: 'localnet' });
			expect(ctx.manifestPath).toBe(manifestPath);
			expect(ctx.manifestVersion).toBe(CONSUMER_MANIFEST_VERSION);
			// Manifest omits `services`; the reader defaults it to `{}` so the
			// public build-integration surface stays a record.
			expect(ctx.services).toEqual({});
			const rpc = ctx.endpoints.byName('rpc');
			expect(rpc).toBeDefined();
			expect(rpc?.url).toBe('http://sui-rpc.demo.localhost:5174');
			expect(rpc?.wireProtocol).toBe('http');
			expect(manifestEnvelopeFromStackContext(ctx).endpoints).toHaveProperty('sui#0:rpc');
		}));

	it.effect('round-trips app extras through the manifest writer and runtime reader', () =>
		withTempRoot('devstack-read', (tmp) =>
			Effect.gen(function* () {
				const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
				const extras = {
					openLobbyId: '0xfeed',
					sealKeyServer: {
						objectId: '0xseal',
						url: 'http://seal.localhost:5175',
					},
				};
				const envelope = yield* buildEnvelope({
					identity: { app: 'demo', stack: 'main', network: 'localnet' },
					extras,
				});
				yield* writeManifest(envelope, manifestPath);

				const ctx = readStackContext({ manifestPath });
				expect(ctx.extras).toEqual(extras);
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		),
	);

	it('walks up from a nested cwd to find the manifest', () =>
		withTempRootSync('devstack-read', (tmp) => {
			const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
			makeManifestAt(manifestPath, validEnvelope());
			const nested = join(tmp, 'a', 'b');
			mkdirSync(nested, { recursive: true });
			const ctx = readStackContext({ cwd: nested });
			expect(ctx.manifestPath).toBe(manifestPath);
		}));

	it('throws ManifestShapeError(phase=parse) on corrupt JSON', () =>
		withTempRootSync('devstack-read', (tmp) => {
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
		}));

	it('throws ManifestShapeError(phase=shape) on wrong envelope shape', () =>
		withTempRootSync('devstack-read', (tmp) => {
			const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
			makeManifestAt(manifestPath, { totally: 'wrong shape' });
			try {
				readStackContext({ manifestPath });
				expect.fail('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestShapeError);
				expect((err as ManifestShapeError).phase).toBe('shape');
			}
		}));

	it('throws ManifestShapeError(phase=version) on version mismatch', () =>
		withTempRootSync('devstack-read', (tmp) => {
			const manifestPath = join(tmp, '.devstack', 'stacks', 'main', 'manifest.json');
			makeManifestAt(manifestPath, validEnvelope({ manifestVersion: 999 }));
			try {
				readStackContext({ manifestPath });
				expect.fail('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestShapeError);
				expect((err as ManifestShapeError).phase).toBe('version');
			}
		}));

	it('throws ManifestDiscoveryError when no manifest exists', () =>
		withTempRootSync('devstack-read', (tmp) => {
			try {
				readStackContext({ cwd: tmp, stateDir: '.devstack-missing-sentinel' });
				expect.fail('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(ManifestDiscoveryError);
			}
		}));
});
