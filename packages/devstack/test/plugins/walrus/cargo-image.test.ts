// Unit tests for the walrus cargo-image lifted-sibling key derivation
// and pure resolver policy.
// The (plugin, kind, scope, inputHash) tuple drives first-wins dedup
// across composites + compile-time conflict refusal — this test pins
// the shape so the type-level conflict refusal stays sound after a
// refactor.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';

import type {
	ContainerBuildContext,
	ContainerRuntime,
} from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_SUI_VERSION,
	defaultWalrusCargoImageSiblingKey,
	resolveDefaultCargoImage,
	walrusCargoImageSiblingKey,
} from '../../../src/plugins/walrus/lifted-siblings/cargo-image.ts';
import { DEFAULT_WALRUS_REF } from '../../../src/plugins/walrus/lifted-siblings/source-fetch.ts';

const ORIGINAL_WALRUS_CARGO_IMAGE_OVERRIDE = process.env.WALRUS_CARGO_IMAGE_OVERRIDE;

const restoreEnvVar = (name: string, value: string | undefined) => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

const unusedRuntimeMethod = () => Effect.die('not used');

const makeRuntimeStub = (ensureImage: ContainerRuntime['ensureImage']): ContainerRuntime => ({
	ensureImage,
	ensureNetwork: unusedRuntimeMethod,
	ensureContainer: unusedRuntimeMethod,
	exec: unusedRuntimeMethod,
	runOneShot: unusedRuntimeMethod,
	inspectByLabels: unusedRuntimeMethod,
	followLogs: () => Stream.empty,
	pauseAndCommit: unusedRuntimeMethod,
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: unusedRuntimeMethod,
	tagImage: unusedRuntimeMethod,
	removeImage: unusedRuntimeMethod,
	unpause: unusedRuntimeMethod,
	stop: unusedRuntimeMethod,
	sweepOrphans: unusedRuntimeMethod,
	removeManagedContainers: unusedRuntimeMethod,
	removeManagedImages: unusedRuntimeMethod,
	removeManagedNetworks: unusedRuntimeMethod,
	removeManagedVolumes: unusedRuntimeMethod,
});

afterEach(() => {
	restoreEnvVar('WALRUS_CARGO_IMAGE_OVERRIDE', ORIGINAL_WALRUS_CARGO_IMAGE_OVERRIDE);
});

describe('walrusCargoImageSiblingKey', () => {
	it('folds (ref, sui) into the inputHash', () => {
		const k = walrusCargoImageSiblingKey('vA', 'vB');
		expect(k.plugin).toBe('walrus');
		expect(k.kind).toBe('cargo-image');
		expect(k.scope).toBe('per-process');
		expect(k.inputHash).toBe('vA|vB');
	});

	it('two composites with the SAME pair share one key (dedup target)', () => {
		const a = walrusCargoImageSiblingKey('x', 'y');
		const b = walrusCargoImageSiblingKey('x', 'y');
		// Same shape — substrate uses structural compare to dedup.
		expect(a.plugin).toBe(b.plugin);
		expect(a.kind).toBe(b.kind);
		expect(a.scope).toBe(b.scope);
		expect(a.inputHash).toBe(b.inputHash);
	});

	it('two composites with DIFFERENT refs surface DIFFERENT inputHashes', () => {
		const a = walrusCargoImageSiblingKey('vA', 'vB');
		const b = walrusCargoImageSiblingKey('vA2', 'vB');
		expect(a.inputHash).not.toBe(b.inputHash);
	});

	it('default key uses the pinned defaults', () => {
		const k = defaultWalrusCargoImageSiblingKey();
		expect(k.inputHash).toBe(`${DEFAULT_WALRUS_REF}|${DEFAULT_SUI_VERSION}`);
	});

	it('default release tag is pinned to the deploy-capable Walrus release', () => {
		expect(DEFAULT_WALRUS_REF).toBe('testnet-v1.49.1');
	});

	it('vendored image uses release binaries and verifies the required Walrus tools', () => {
		const dockerfile = readFileSync(
			new URL('../../../images/walrus/Dockerfile', import.meta.url),
			'utf8',
		);
		expect(dockerfile).toContain('walrus-${WALRUS_VERSION}-${WALRUS_PLATFORM}.tgz');
		expect(dockerfile).toContain('arm64) WALRUS_PLATFORM=ubuntu-aarch64');
		expect(dockerfile).toContain('amd64) WALRUS_PLATFORM=ubuntu-x86_64');
		expect(dockerfile).toContain('EXPECTED_FILE_ARCH');
		expect(dockerfile).toContain('is not native for TARGETARCH=');
		expect(dockerfile).toContain('for bin in walrus walrus-node walrus-deploy');
		expect(dockerfile).not.toContain('cargo build');
		expect(dockerfile).not.toContain('rustup');
	});

	it('deploy script leaves only host-owned snapshotable output in the bind mount', () => {
		const script = readFileSync(
			new URL('../../../images/walrus/deploy-walrus.sh', import.meta.url),
			'utf8',
		);
		expect(script).toContain('DEVSTACK_HOST_UID_GID');
		expect(script).toContain('chown -R "$DEVSTACK_HOST_UID_GID" "$WORKING_DIR"');
		expect(script).toContain('rm -rf "$HOME"');
	});
});

describe('resolveDefaultCargoImage — native release-binary policy', () => {
	it.effect('uses the native Docker build path without a platform override', () =>
		Effect.gen(function* () {
			delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
			let captured: ContainerBuildContext | null = null;
			const runtime = makeRuntimeStub((ctx) => {
				captured = ctx;
				return Effect.succeed({ digest: 'sha256:built', tag: 'devstack-walrus:test' });
			});

			const image = yield* Effect.scoped(resolveDefaultCargoImage(runtime));

			expect(image).toEqual({ digest: 'sha256:built', tag: 'devstack-walrus:test' });
			expect(captured).not.toBeNull();
			expect(captured!.dockerfile).toBe('Dockerfile');
			expect(captured!.platform).toBeUndefined();
			expect(captured!.contextPath).toMatch(/images\/walrus\/?$/);
			expect(captured!.buildArgs).toEqual({
				WALRUS_VERSION: DEFAULT_WALRUS_REF,
				SUI_VERSION: DEFAULT_SUI_VERSION,
			});
		}),
	);

	it.effect('lets WALRUS_CARGO_IMAGE_OVERRIDE bypass the Docker build', () =>
		Effect.gen(function* () {
			process.env.WALRUS_CARGO_IMAGE_OVERRIDE = 'walrus-compatible:latest';
			const runtime = makeRuntimeStub(() =>
				Effect.die('ensureImage should not be called when override is set'),
			);

			const image = yield* Effect.scoped(resolveDefaultCargoImage(runtime));

			expect(image).toEqual({
				digest: 'walrus-compatible:latest',
				tag: 'walrus-compatible:latest',
			});
		}),
	);
});
