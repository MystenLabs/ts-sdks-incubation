// Fork-mode image selection: which image a fork boots from, how that
// choice is keyed into fork state, and the Dockerfile contract the
// sui-tools path relies on.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from '@effect/vitest';

import type { ContainerBuildContext } from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_SUI_FORK_REV,
	FORK_ENTRYPOINT,
	FORK_IMAGE_ENV_VAR,
	forkBinaryVersion,
	forkDataDirKey,
	planForkImage,
	resolveForkImage,
	validateForkImageOptions,
} from '../../../src/plugins/sui/mode/fork.ts';
import type { SuiForkOptions } from '../../../src/plugins/sui/mode/spec.ts';
import {
	DEFAULT_SUI_TOOLS_REF,
	SUI_TOOLS_REF_ENV_VAR,
	suiToolsImage,
} from '../../../src/plugins/sui/move/index.ts';
import { appName, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';

const IDENTITY: Identity = {
	app: appName('test-app'),
	stack: stackName('test-stack'),
	network: 'testnet-fork',
};

const base: SuiForkOptions = { mode: 'fork', upstream: 'testnet' };

const imagesDir = resolve(import.meta.dirname, '../../../images');

const recordingRuntime = () => {
	const builds: Array<ContainerBuildContext> = [];
	const pulls: Array<string> = [];
	const runtime = makeContainerRuntimeStub({
		ensureImage: (build) =>
			Effect.sync(() => {
				builds.push(build);
				return { digest: 'sha256:built', tag: 'built' };
			}),
		pullImage: (ref) =>
			Effect.sync(() => {
				pulls.push(ref);
				return { digest: 'sha256:pulled', tag: ref };
			}),
	});
	return { runtime, builds, pulls };
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('fork image plan', () => {
	it('pins the env var names other tooling agrees on', () => {
		expect(SUI_TOOLS_REF_ENV_VAR).toBe('DEVSTACK_SUI_TOOLS_REF');
		expect(FORK_IMAGE_ENV_VAR).toBe('DEVSTACK_SUI_FORK_IMAGE');
	});

	it('defaults to the source build at the bundled revision', () => {
		expect(planForkImage(base)).toEqual({ kind: 'source', rev: DEFAULT_SUI_FORK_REV });
		expect(planForkImage({ ...base, version: 'abc' })).toEqual({ kind: 'source', rev: 'abc' });
	});

	it('never falls back to the bundled sui-tools pin, which predates sui-fork', () => {
		expect(planForkImage(base)).not.toEqual({ kind: 'sui-tools', ref: DEFAULT_SUI_TOOLS_REF });
	});

	it('uses the sui-tools path for a configured ref, option before env', () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(planForkImage(base)).toEqual({ kind: 'sui-tools', ref: 'from-env' });
		expect(planForkImage({ ...base, suiToolsRef: 'from-config' })).toEqual({
			kind: 'sui-tools',
			ref: 'from-config',
		});
	});

	it('lets the env sui-tools ref displace a config version, like the prebuilt env var always has', () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(planForkImage({ ...base, version: 'abc' })).toEqual({
			kind: 'sui-tools',
			ref: 'from-env',
		});
	});

	it('prefers a sui-tools ref over the complete-image env var, and that over source', () => {
		vi.stubEnv(FORK_IMAGE_ENV_VAR, 'example.com/sui-fork:x');
		expect(planForkImage(base)).toEqual({
			kind: 'prebuilt-or-source',
			ref: 'example.com/sui-fork:x',
			rev: DEFAULT_SUI_FORK_REV,
		});
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(planForkImage(base)).toEqual({ kind: 'sui-tools', ref: 'from-env' });
	});

	it('lets explicit image config win over every ref', () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(planForkImage({ ...base, image: { pull: 'me/sui-fork:1' } })).toEqual({
			kind: 'pull',
			ref: 'me/sui-fork:1',
		});
		expect(
			planForkImage({ ...base, suiToolsRef: 'r', image: { build: { context: '/ctx' } } }),
		).toEqual({
			kind: 'custom-build',
			context: '/ctx',
			dockerfile: 'Dockerfile',
			rev: DEFAULT_SUI_FORK_REV,
			suiToolsRef: 'r',
		});
	});
});

describe('fork binary identity', () => {
	it('keeps the bare revision for source-path stacks so existing data dirs stay addressable', () => {
		expect(forkBinaryVersion(base)).toBe(DEFAULT_SUI_FORK_REV);
		expect(forkBinaryVersion({ ...base, version: 'abc' })).toBe('abc');
	});

	it('keys fork state by the sui-tools ref when one is in play', () => {
		expect(forkBinaryVersion({ ...base, suiToolsRef: 'r1' })).toBe('sui-tools:r1');
		const source = forkDataDirKey(base);
		const r1 = forkDataDirKey({ ...base, suiToolsRef: 'r1' });
		const r2 = forkDataDirKey({ ...base, suiToolsRef: 'r2' });
		expect(new Set([source, r1, r2]).size).toBe(3);
	});

	it('keys fork state identically whether the ref came from config or env', () => {
		const fromConfig = forkDataDirKey({ ...base, suiToolsRef: 'r1' });
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'r1');
		expect(forkDataDirKey(base)).toBe(fromConfig);
	});
});

describe('fork image option validation', () => {
	it.effect('accepts a lone suiToolsRef and the plain default', () =>
		Effect.gen(function* () {
			yield* validateForkImageOptions(base);
			yield* validateForkImageOptions({ ...base, suiToolsRef: 'r' });
			yield* validateForkImageOptions({
				...base,
				suiToolsRef: 'r',
				image: { build: { context: '/c' } },
			});
		}),
	);

	it.effect('rejects suiToolsRef alongside image.pull', () =>
		Effect.gen(function* () {
			const error = yield* validateForkImageOptions({
				...base,
				suiToolsRef: 'r',
				image: { pull: 'me/sui-fork:1' },
			}).pipe(Effect.flip);
			expect(error._tag).toBe('SuiConfigError');
			expect(error.field).toBe('suiToolsRef');
			expect(error.message).toContain('image.pull');
		}),
	);

	it.effect('rejects suiToolsRef alongside a source version pin', () =>
		Effect.gen(function* () {
			const error = yield* validateForkImageOptions({
				...base,
				suiToolsRef: 'r',
				version: 'abc',
			}).pipe(Effect.flip);
			expect(error._tag).toBe('SuiConfigError');
			expect(error.message).toContain('version');
		}),
	);
});

describe('resolveForkImage', () => {
	it.effect(
		'layers the shared sui image onto the requested sui-tools build and overrides the entrypoint',
		() =>
			Effect.gen(function* () {
				const { runtime, builds, pulls } = recordingRuntime();
				const resolved = yield* resolveForkImage(runtime, IDENTITY, {
					...base,
					suiToolsRef: 'testnet-v1.80.0',
				});

				expect(pulls).toEqual([]);
				expect(builds).toEqual([
					expect.objectContaining({
						dockerfile: 'sui/Dockerfile',
						buildArgs: { SUI_TOOLS_IMAGE: suiToolsImage('testnet-v1.80.0') },
						owner: { app: 'test-app', stack: 'test-stack', plugin: 'sui', role: 'validator' },
					}),
				]);
				expect(resolved).toEqual({
					ref: { digest: 'sha256:built', tag: 'built' },
					entrypoint: FORK_ENTRYPOINT,
				});
			}),
	);

	it.effect(
		'builds sui-fork from source with the image default entrypoint when nothing is configured',
		() =>
			Effect.gen(function* () {
				const { runtime, builds } = recordingRuntime();
				const resolved = yield* resolveForkImage(runtime, IDENTITY, base);

				expect(builds).toEqual([
					expect.objectContaining({
						dockerfile: 'sui-fork/Dockerfile',
						buildArgs: expect.objectContaining({ SUI_FORK_REV: DEFAULT_SUI_FORK_REV }),
					}),
				]);
				expect(resolved.entrypoint).toBeUndefined();
			}),
	);

	it.effect('hands a caller Dockerfile the sui-tools image alongside the source build args', () =>
		Effect.gen(function* () {
			const { runtime, builds } = recordingRuntime();
			yield* resolveForkImage(runtime, IDENTITY, {
				...base,
				suiToolsRef: 'r',
				image: { build: { context: '/ctx', dockerfile: 'Fork.Dockerfile' } },
			});

			expect(builds).toEqual([
				expect.objectContaining({
					contextPath: '/ctx',
					dockerfile: 'Fork.Dockerfile',
					buildArgs: expect.objectContaining({
						SUI_FORK_REV: DEFAULT_SUI_FORK_REV,
						SUI_TOOLS_IMAGE: suiToolsImage('r'),
					}),
				}),
			]);
		}),
	);

	it.effect('falls back to the source build when the complete-image env var cannot be pulled', () =>
		Effect.gen(function* () {
			vi.stubEnv(FORK_IMAGE_ENV_VAR, 'example.com/sui-fork:missing');
			const builds: Array<ContainerBuildContext> = [];
			const runtime = makeContainerRuntimeStub({
				ensureImage: (build) =>
					Effect.sync(() => {
						builds.push(build);
						return { digest: 'sha256:built', tag: 'built' };
					}),
				// No `pullImage`: the runtime cannot pull at all.
			});
			const resolved = yield* resolveForkImage(runtime, IDENTITY, base);

			expect(builds.map((build) => build.dockerfile)).toEqual(['sui-fork/Dockerfile']);
			expect(resolved.entrypoint).toBeUndefined();
		}),
	);
});

describe('shared sui image contract for fork mode', () => {
	it('ships the fork entrypoint and its signal shim at the paths fork mode expects', () => {
		const dockerfile = readFileSync(resolve(imagesDir, 'sui/Dockerfile'), 'utf8');
		const forkEntrypoint = readFileSync(resolve(imagesDir, 'sui-fork/entrypoint.sh'), 'utf8');

		expect(dockerfile).toContain(`COPY sui-fork/entrypoint.sh ${FORK_ENTRYPOINT}`);
		expect(dockerfile).toContain(`RUN chmod +x ${FORK_ENTRYPOINT}`);
		expect(dockerfile).toContain(
			'COPY _shared/signal-forward.sh /usr/local/lib/devstack/signal-forward.sh',
		);
		expect(forkEntrypoint).toContain('. /usr/local/lib/devstack/signal-forward.sh');
		// The local-mode entrypoint stays the image default; fork mode overrides.
		expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/devstack-entrypoint.sh"]');
	});
});
