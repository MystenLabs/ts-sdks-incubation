// Unit tests for the walrus cargo-image lifted-sibling key derivation
// and pure resolver policy.
// The (plugin, kind, scope, inputHash) tuple drives first-wins dedup
// across composites + compile-time conflict refusal — this test pins
// the shape so the type-level conflict refusal stays sound after a
// refactor.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Stream } from 'effect';

import type {
	ContainerBuildContext,
	ContainerRuntime,
} from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_RUST_TOOLCHAIN,
	DEFAULT_SUI_VERSION,
	defaultWalrusCargoImageSiblingKey,
	resolveDefaultCargoImage,
	walrusCargoImageSiblingKey,
} from '../../../src/plugins/walrus/lifted-siblings/cargo-image.ts';
import { DEFAULT_WALRUS_REF } from '../../../src/plugins/walrus/lifted-siblings/source-fetch.ts';

const ORIGINAL_WALRUS_CARGO_IMAGE_OVERRIDE = process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
const ORIGINAL_DOCKER_DEFAULT_PLATFORM = process.env.DOCKER_DEFAULT_PLATFORM;
const ORIGINAL_PROCESS_ARCH = Object.getOwnPropertyDescriptor(process, 'arch')!;

const restoreEnvVar = (name: string, value: string | undefined) => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

const setProcessArch = (arch: string) => {
	Object.defineProperty(process, 'arch', { ...ORIGINAL_PROCESS_ARCH, value: arch });
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
	restoreEnvVar('DOCKER_DEFAULT_PLATFORM', ORIGINAL_DOCKER_DEFAULT_PLATFORM);
	Object.defineProperty(process, 'arch', ORIGINAL_PROCESS_ARCH);
});

describe('walrusCargoImageSiblingKey', () => {
	it('folds (ref, sui, rust) into the inputHash', () => {
		const k = walrusCargoImageSiblingKey('vA', 'vB', 'vC');
		expect(k.plugin).toBe('walrus');
		expect(k.kind).toBe('cargo-image');
		expect(k.scope).toBe('per-process');
		expect(k.inputHash).toBe('vA|vB|vC');
	});

	it('two composites with the SAME triple share one key (dedup target)', () => {
		const a = walrusCargoImageSiblingKey('x', 'y', 'z');
		const b = walrusCargoImageSiblingKey('x', 'y', 'z');
		// Same shape — substrate uses structural compare to dedup.
		expect(a.plugin).toBe(b.plugin);
		expect(a.kind).toBe(b.kind);
		expect(a.scope).toBe(b.scope);
		expect(a.inputHash).toBe(b.inputHash);
	});

	it('two composites with DIFFERENT refs surface DIFFERENT inputHashes', () => {
		const a = walrusCargoImageSiblingKey('vA', 'vB', 'vC');
		const b = walrusCargoImageSiblingKey('vA2', 'vB', 'vC');
		expect(a.inputHash).not.toBe(b.inputHash);
	});

	it('default key uses the pinned defaults', () => {
		const k = defaultWalrusCargoImageSiblingKey();
		expect(k.inputHash).toBe(
			`${DEFAULT_WALRUS_REF}|${DEFAULT_SUI_VERSION}|${DEFAULT_RUST_TOOLCHAIN}`,
		);
	});

	it('default release is pinned to a tarball that includes walrus-deploy', () => {
		expect(DEFAULT_WALRUS_REF).toBe('devnet-v1.49.0');
	});

	it('vendored image fails during build if the release omits required binaries', () => {
		const dockerfile = readFileSync(
			new URL('../../../images/walrus/Dockerfile', import.meta.url),
			'utf8',
		);
		expect(dockerfile).toContain('for bin in walrus walrus-node walrus-deploy');
		expect(dockerfile).toContain('missing required binary');
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

describe('resolveDefaultCargoImage — linux/arm64 policy', () => {
	it.effect('fails before Docker build for native arm64 without override', () =>
		Effect.gen(function* () {
			delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
			delete process.env.DOCKER_DEFAULT_PLATFORM;
			setProcessArch('arm64');
			let ensureImageCalled = false;
			const runtime = makeRuntimeStub(() => {
				ensureImageCalled = true;
				return Effect.succeed({ digest: 'sha256:built', tag: 'devstack-walrus:test' });
			});

			const exit = yield* Effect.exit(Effect.scoped(resolveDefaultCargoImage(runtime)));

			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.findErrorOption(exit);
			expect(error._tag).toBe('Some');
			if (error._tag === 'Some') {
				expect(error.value._tag).toBe('WalrusPluginError');
				expect(error.value.phase).toBe('image-build');
				expect(error.value.message).toContain('native linux/arm64');
				expect(error.value.message).toContain('unsupported');
				expect(error.value.message).toContain('ubuntu-aarch64');
				expect(error.value.message).toContain('WALRUS_CARGO_IMAGE_OVERRIDE');
				expect(error.value.message).toContain('source-build fallback');
			}
			expect(ensureImageCalled).toBe(false);
		}),
	);

	it.effect('lets WALRUS_CARGO_IMAGE_OVERRIDE bypass the native arm64 guard', () =>
		Effect.gen(function* () {
			process.env.WALRUS_CARGO_IMAGE_OVERRIDE = 'walrus-compatible:latest';
			delete process.env.DOCKER_DEFAULT_PLATFORM;
			setProcessArch('arm64');
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

	it.effect('preserves the linux/amd64 build path', () =>
		Effect.gen(function* () {
			delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
			delete process.env.DOCKER_DEFAULT_PLATFORM;
			setProcessArch('x64');
			let captured: ContainerBuildContext | null = null;
			const runtime = makeRuntimeStub((ctx) => {
				captured = ctx;
				return Effect.succeed({ digest: 'sha256:built', tag: 'devstack-walrus:test' });
			});

			const image = yield* Effect.scoped(resolveDefaultCargoImage(runtime));

			expect(image).toEqual({ digest: 'sha256:built', tag: 'devstack-walrus:test' });
			expect(captured).not.toBeNull();
			expect(captured!.dockerfile).toBe('Dockerfile');
			expect(captured!.contextPath).toMatch(/images\/walrus\/?$/);
			expect(captured!.buildArgs).toEqual({
				WALRUS_VERSION: DEFAULT_WALRUS_REF,
				SUI_VERSION: DEFAULT_SUI_VERSION,
			});
		}),
	);

	it.effect('allows an explicit linux/amd64 Docker target on an arm64 host', () =>
		Effect.gen(function* () {
			delete process.env.WALRUS_CARGO_IMAGE_OVERRIDE;
			process.env.DOCKER_DEFAULT_PLATFORM = 'linux/amd64';
			setProcessArch('arm64');
			let captured: ContainerBuildContext | null = null;
			const runtime = makeRuntimeStub((ctx) => {
				captured = ctx;
				return Effect.succeed({ digest: 'sha256:built', tag: 'devstack-walrus:test' });
			});

			const image = yield* Effect.scoped(resolveDefaultCargoImage(runtime));

			expect(image.digest).toBe('sha256:built');
			expect(captured).not.toBeNull();
		}),
	);
});
