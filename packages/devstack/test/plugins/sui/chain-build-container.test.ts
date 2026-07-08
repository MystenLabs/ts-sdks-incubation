import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { Deferred, Effect, Fiber, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	acquireChainBuildContainer,
	moveBuildLockPathFor,
} from '../../../src/plugins/sui/chain-build-container.ts';
import { makeContainerRuntimeStub } from '../../helpers/container-runtime-stub.ts';

const handleFor = (spec: EnsureContainerSpec): ContainerHandle => ({
	id: 'build-container-id',
	name: spec.name,
	labels: spec.labels,
	imageName: spec.image.tag ?? spec.image.digest,
	status: 'running',
	ips: [],
});

const runtimeFromExec = (exec: ContainerRuntime['exec']): ContainerRuntime =>
	makeContainerRuntimeStub({
		ensureContainer: (spec) => Effect.succeed(handleFor(spec)),
		exec,
	});

const runtimeCapturingEnsureSpec = (specs: EnsureContainerSpec[]): ContainerRuntime => ({
	...runtimeFromExec(() => Effect.succeed(okExecResult)),
	ensureContainer: (spec) =>
		Effect.sync(() => {
			specs.push(spec);
			return handleFor(spec);
		}),
});

/** Capture every `exec` argv the build path emits (the third element
 *  is the `sh -c` inner script). */
const runtimeCapturingExecArgv = (argvs: ReadonlyArray<string>[]): ContainerRuntime =>
	runtimeFromExec((_handle, argv) =>
		Effect.sync(() => {
			argvs.push([...argv]);
			return okExecResult;
		}),
	);

const makeFixture = () => {
	const root = mkdtempSync(join(tmpdir(), 'chain-build-container-test-'));
	const appDir = join(root, 'app');
	// NESTED package (path contains a slash relative to appDir) WITH a
	// sibling local dep — the exact in-repo shape (e.g.
	// examples/deepbook-trader/move/vendor/.../Move.toml) that the
	// scoped-copy regression broke: copying only `/workspace/packages/demo`
	// both needs the intermediate `packages/` dir to exist and drops the
	// `{ local = "../token" }` sibling.
	const packagePath = join(appDir, 'packages', 'demo');
	const siblingPath = join(appDir, 'packages', 'token');
	const moveHome = join(root, 'home', '.move');
	mkdirSync(packagePath, { recursive: true });
	mkdirSync(siblingPath, { recursive: true });
	mkdirSync(moveHome, { recursive: true });
	writeFileSync(
		join(packagePath, 'Move.toml'),
		'[package]\nname = "demo"\n\n[dependencies]\ntoken = { local = "../token" }\n',
	);
	writeFileSync(join(siblingPath, 'Move.toml'), '[package]\nname = "token"\n');
	return {
		root,
		packagePath,
		siblingPath,
		spec: {
			app: 'demo',
			stack: 'test',
			appDir,
			moveHome,
			image: { digest: 'sha256:sui' },
		},
	};
};

const okExecResult = { exitCode: 0, stdout: '{}', stderr: '' };

describe('chain build container move-build lock', () => {
	it.effect('uses a TERM-aware sleeper for fast scope shutdown', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				const specs: EnsureContainerSpec[] = [];
				yield* Effect.scoped(
					acquireChainBuildContainer(runtimeCapturingEnsureSpec(specs), fixture.spec),
				);

				expect(specs[0]?.entrypoint).toBe('sh');
				expect(specs[0]?.command?.[0]).toBe('-c');
				expect(specs[0]?.command?.[1]).toContain('trap');
				expect(specs[0]?.command?.[1]).toContain('TERM');
				expect(specs[0]?.stopGraceSeconds).toBe(2);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);

	it.effect(
		'runBuild stages a nested package without dropping sibling local deps (whole-tree copy)',
		() =>
			Effect.gen(function* () {
				const fixture = makeFixture();
				try {
					const argvs: ReadonlyArray<string>[] = [];
					yield* Effect.scoped(
						Effect.gen(function* () {
							const buildContainer = yield* acquireChainBuildContainer(
								runtimeCapturingExecArgv(argvs),
								fixture.spec,
							);
							// Host path → `/workspace/packages/demo` → pkgName
							// `packages/demo` (the nested, slash-bearing trigger).
							yield* buildContainer.runBuild(fixture.packagePath, { buildEnv: 'localnet' });
						}),
					);

					expect(argvs.length).toBe(1);
					const argv = argvs[0]!;
					expect(argv[0]).toBe('sh');
					expect(argv[1]).toBe('-c');
					const inner = argv[2]!;

					// (1) The staging copies the WHOLE mounted tree — this is what
					// both materialises the nested `packages/` parent AND carries
					// the `{ local = "../token" }` sibling at `/workspace/packages/token`.
					// A whole-`/workspace` copy is the only staging form that keeps
					// siblings present without per-dep enumeration.
					expect(inner).toContain('cp -a /workspace/. ');

					// (2) Falsifiable against the exact regression: the scoped copy
					// `cp -a /workspace/'packages/demo' <scratch>/'packages/demo'`
					// mkdir's only the scratch ROOT, so the intermediate `packages/`
					// is missing and `set -e` aborts before `sui move build` — AND it
					// drops the `../token` sibling. The fix must never emit it.
					expect(inner).not.toContain("cp -a /workspace/'packages/demo'");

					// (3) The build still targets the nested package path inside the
					// scratch tree (proves the nested pkgName threaded through, not a
					// flattened basename).
					expect(inner).toContain("sui move build --path /tmp/move-build-$$/'packages/demo'");
					expect(inner).toContain("--build-env 'localnet'");
					expect(inner).toContain('find /tmp/move-build-$$ -type f -name Published.toml');
				} finally {
					rmSync(fixture.root, { recursive: true, force: true });
				}
			}),
	);

	it.effect('runBuild holds the host-wide move-build lock around docker exec', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				const lockPath = moveBuildLockPathFor(fixture.spec.appDir, fixture.spec.moveHome);
				let sawLock = false;
				const runtime = runtimeFromExec(() =>
					Effect.sync(() => {
						sawLock = existsSync(lockPath);
						const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { readonly pid: number };
						expect(holder.pid).toBe(process.pid);
						return okExecResult;
					}),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const buildContainer = yield* acquireChainBuildContainer(runtime, fixture.spec);
						const result = yield* buildContainer.runBuild(fixture.packagePath);
						expect(result).toEqual(okExecResult);
					}),
				);

				expect(sawLock).toBe(true);
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('runBuild reclaims stale move-build lock files before docker exec', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				const lockPath = moveBuildLockPathFor(fixture.spec.appDir, fixture.spec.moveHome);
				mkdirSync(dirname(lockPath), { recursive: true });
				writeFileSync(
					lockPath,
					JSON.stringify({
						pid: -1,
						startTime: 0,
						hostname: hostname(),
						claimedAt: Date.now() - 60_000,
						heartbeatAt: Date.now() - 60_000,
						intent: 'normal',
					}),
				);

				let execCount = 0;
				const runtime = runtimeFromExec(() =>
					Effect.sync(() => {
						execCount += 1;
						const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { readonly pid: number };
						expect(holder.pid).toBe(process.pid);
						return okExecResult;
					}),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const buildContainer = yield* acquireChainBuildContainer(runtime, fixture.spec);
						const result = yield* buildContainer.runBuild(fixture.packagePath);
						expect(result).toEqual(okExecResult);
					}),
				);

				expect(execCount).toBe(1);
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);

	it.live('runBuild serializes concurrent docker execs through the move-build lock', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const firstEntered = yield* Deferred.make<void>();
						const releaseFirst = yield* Deferred.make<void>();
						const callCount = yield* Ref.make(0);
						const events = yield* Ref.make<ReadonlyArray<string>>([]);
						const append = (event: string) => Ref.update(events, (current) => [...current, event]);
						const runtime = runtimeFromExec(() =>
							Effect.gen(function* () {
								const call = yield* Ref.updateAndGet(callCount, (n) => n + 1);
								if (call === 1) {
									yield* append('first-in');
									yield* Deferred.succeed(firstEntered, undefined);
									yield* Deferred.await(releaseFirst);
									yield* append('first-out');
								} else {
									yield* append('second-in');
									yield* append('second-out');
								}
								return okExecResult;
							}),
						);
						const buildContainer = yield* acquireChainBuildContainer(runtime, fixture.spec);

						const first = yield* Effect.forkScoped(buildContainer.runBuild(fixture.packagePath));
						yield* Deferred.await(firstEntered);
						const second = yield* Effect.forkScoped(buildContainer.runBuild(fixture.packagePath));

						yield* Effect.sleep('75 millis');
						expect(yield* Ref.get(events)).toEqual(['first-in']);

						yield* Deferred.succeed(releaseFirst, undefined);
						yield* Fiber.join(first);
						yield* Fiber.join(second);

						expect(yield* Ref.get(events)).toEqual([
							'first-in',
							'first-out',
							'second-in',
							'second-out',
						]);
					}),
				);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);
});
