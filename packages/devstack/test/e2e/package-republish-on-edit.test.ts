// End-to-end proof of the dev-loop the file watcher enables: editing a
// local Move package's source while the stack is live RE-PUBLISHES the
// package with a NEW on-chain id, and devstack writes NOTHING under the
// source tree (so the watcher can't self-trigger a restart loop).
//
// The real fs watcher (`startFileWatcher`) only runs under `devstack up`;
// here we drive its exact downstream effect — a `selective-restart.requested`
// for the package plugin — through the supervisor handle, which is the same
// command `notifyWatchFire` issues. What this pins:
//
//   1. Re-acquire after a source edit hits a CACHE MISS (the source hash
//      changed) → a fresh build + publish → a DIFFERENT package id.
//   2. The source tree is byte-for-byte the developer's: the only path that
//      changed is the file WE edited; devstack added no `build/` dir, no
//      rewritten `Move.lock`, nothing — so the watcher never sees a
//      devstack-authored change (no restart loop).
//
// Prereq: docker reachable. Two publishes (cold boot + republish) on top of
// the sui container start, so a generous timeout.

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Effect, Layer } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { afterEach, describe, expect, it } from 'vitest';

import { account, defineDevstack, localPackage, sui } from '../../src/index.ts';
import { readStackEngine } from '../../src/api/define-devstack.ts';
import { pluginKey } from '../../src/substrate/brand.ts';
import type { ResolvedLocalPackage } from '../../src/plugins/package/registry.ts';
import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import type {
	DevstackDeployment,
	NetworkDeployment,
} from '../../src/orchestrators/codegen/deployment.ts';
import {
	MoveCodegenService,
	MoveSummaryRunnerService,
	stubMoveCodegen,
	stubMoveSummaryRunner,
} from '../../src/orchestrators/codegen/bindings.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../src/orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../src/orchestrators/codegen/service.ts';
import { runBoot } from './boot-config-impl.ts';
import { dockerReachable } from './docker-prune.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', 'fixtures', 'move', 'hello');

let scratch: string | null = null;
afterEach(() => {
	if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
	scratch = null;
});

/** Recursively list every file under `dir`, root-relative, sorted — the
 *  fingerprint used to prove devstack wrote nothing into the source tree. */
const listFiles = (dir: string): string[] => {
	const out: string[] = [];
	const walk = (cur: string): void => {
		for (const entry of readdirSync(cur, { withFileTypes: true })) {
			const abs = join(cur, entry.name);
			if (entry.isDirectory()) walk(abs);
			else out.push(relative(dir, abs));
		}
	};
	walk(dir);
	return out.sort();
};

const stubStaticCodegenLayer = (outputDir: string) => {
	const moveLayers = Layer.mergeAll(
		Layer.succeed(MoveSummaryRunnerService)(
			stubMoveSummaryRunner((sourcePath) => ({
				packageName: sourcePath,
				sourcePath,
				summaryJson: {},
			})),
		),
		Layer.succeed(MoveCodegenService)(
			stubMoveCodegen((input) => [
				{
					relPath: `${input.packageName}/index.ts`,
					content: `export const ID = "${input.mvrPlaceholder}";\n`,
				},
			]),
		),
	);
	const nodePlatform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
	return Layer.mergeAll(moveLayers, layerCodegenPaths, nodePlatform).pipe(
		Layer.provide(layerCodegenRoot({ outputDir, stackSubdir: null })),
		Layer.provide(nodePlatform),
	);
};

const staticContributionsFrom = (
	members: ReturnType<typeof readStackEngine>['members'],
): ReadonlyArray<CodegenableDecl> => members.flatMap((member) => member.staticCodegen?.() ?? []);

const emitStaticCodegen = async (
	outputDir: string,
	members: ReturnType<typeof readStackEngine>['members'],
): Promise<void> => {
	const contributions = staticContributionsFrom(members);
	await Effect.runPromise(
		runEmitCycle({ contributions, trackTree: true }).pipe(
			Effect.provide(stubStaticCodegenLayer(outputDir)),
			Effect.asVoid,
		),
	);
};

const packageValue = (values: ReadonlyMap<string, unknown>, name: string): ResolvedLocalPackage => {
	const key = [...values.keys()].find((k) => k.startsWith(`package:${name}`));
	if (key === undefined) throw new Error(`package:${name} not in resolved values`);
	const value = values.get(key);
	if (
		value === undefined ||
		value === null ||
		typeof value !== 'object' ||
		!('packageId' in value)
	) {
		throw new Error(`package:${name} resolved value has no packageId`);
	}
	return value as ResolvedLocalPackage;
};

const defaultNetwork = (deployment: DevstackDeployment): NetworkDeployment => {
	const unit = deployment.networks[deployment.defaultNetwork];
	if (unit === undefined) throw new Error(`deployment missing ${deployment.defaultNetwork}`);
	return unit;
};

describe('editing Move source re-publishes the package', () => {
	it('a source edit yields a new package id and leaves the source tree untouched', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`package-republish-on-edit: skipping — ${docker.detail}`);
			return;
		}

		// Work against an editable COPY of the fixture (never mutate the
		// committed fixture tree).
		scratch = mkdtempSync(join(tmpdir(), 'hello-republish-'));
		const pkgDir = join(scratch, 'hello');
		cpSync(FIXTURE, pkgDir, { recursive: true });
		const sourceFile = join(pkgDir, 'sources', 'hello.move');

		const publisher = account('publisher');
		const engine = readStackEngine(
			defineDevstack({
				members: [sui(), publisher, localPackage('hello', { sourcePath: pkgDir, publisher })],
				stackName: 'hello-republish',
			}),
		);

		const ids: { first?: string; second?: string } = {};
		let filesBefore: string[] = [];
		let filesAfter: string[] = [];

		await runBoot({
			stack: { members: engine.members, options: engine.options },
			appName: 'hello-republish',
			stackName: 'hello-republish',
			withinScope: (ctx) =>
				Effect.gen(function* () {
					const key = [...ctx.resolvedValues.keys()].find((k) => k.startsWith('package:hello'));
					if (key === undefined) return yield* Effect.die('package:hello not in resolved values');

					ids.first = (ctx.resolvedValues.get(key) as ResolvedLocalPackage).packageId;
					filesBefore = listFiles(pkgDir);

					// Edit the source: a new public function changes the source hash
					// (and the compiled module), so the re-acquire can't reuse the
					// cached publish.
					const edited = `${readFileSync(sourceFile, 'utf8')}\npublic fun greet(): u64 { 42 }\n`;
					writeFileSync(sourceFile, edited);

					// Drive the SAME command the file watcher's `notifyWatchFire`
					// issues for a package-source change, and await the re-acquire.
					yield* ctx.runCommand({ tag: 'selective-restart.requested', pluginKey: pluginKey(key) });

					ids.second = (ctx.readResolved(key) as ResolvedLocalPackage | undefined)?.packageId;
					filesAfter = listFiles(pkgDir);
				}),
		});

		// 1. Re-publish minted a NEW package id.
		expect(ids.first).toMatch(/^0x[0-9a-f]+$/);
		expect(ids.second).toMatch(/^0x[0-9a-f]+$/);
		expect(ids.second).not.toBe(ids.first);

		// 2. No restart loop: the ONLY path that changed is the file we edited;
		//    devstack authored nothing under the source tree (no `build/`, no
		//    rewritten `Move.lock`).
		expect(filesAfter).toEqual(filesBefore);
		const lockChanged = filesAfter.includes('Move.lock');
		expect(lockChanged).toBe(false);
	}, 240_000);

	it('changing mvrPlaceholder over a cached publish updates deployment and generated config', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`package-mvr-placeholder-change: skipping — ${docker.detail}`);
			return;
		}

		scratch = mkdtempSync(join(tmpdir(), 'hello-mvr-placeholder-'));
		const pkgDir = join(scratch, 'hello');
		const runtimeRoot = join(scratch, 'runtime');
		const routerStateRoot = join(scratch, 'router');
		const staticOutputDir = join(scratch, 'generated');
		cpSync(FIXTURE, pkgDir, { recursive: true });

		const buildEngine = (mvrPlaceholder?: string) => {
			const publisher = account('publisher');
			return readStackEngine(
				defineDevstack({
					members: [
						sui(),
						publisher,
						localPackage('hello', {
							sourcePath: pkgDir,
							publisher,
							...(mvrPlaceholder === undefined ? {} : { mvrPlaceholder }),
						}),
					],
					stackName: 'hello-mvr-placeholder',
				}),
			);
		};

		const firstEngine = buildEngine();
		const first = await runBoot({
			stack: { members: firstEngine.members, options: firstEngine.options },
			appName: 'hello-mvr-placeholder',
			stackName: 'hello-mvr-placeholder',
			runtimeRoot,
			routerStateRoot,
			runCodegen: true,
			withinScope: () => Effect.void,
		});
		expect(first.failures).toEqual([]);
		expect(first.codegenRun, 'first boot wrote deployment.json').not.toBeNull();

		const firstPackage = packageValue(first.resolvedValues, 'hello');
		const firstDeployment = defaultNetwork(first.codegenRun!.deployment);
		expect(firstPackage.mvrPlaceholder).toBe('@local/hello');
		expect(firstDeployment.mvrOverrides.packages['@local/hello']).toBe(firstPackage.packageId);

		const secondEngine = buildEngine('@local-pkg/hello');
		const second = await runBoot({
			stack: { members: secondEngine.members, options: secondEngine.options },
			appName: 'hello-mvr-placeholder',
			stackName: 'hello-mvr-placeholder',
			runtimeRoot,
			routerStateRoot,
			runCodegen: true,
			withinScope: () => Effect.void,
		});
		expect(second.failures).toEqual([]);
		expect(second.codegenRun, 'second boot wrote deployment.json').not.toBeNull();

		const secondPackage = packageValue(second.resolvedValues, 'hello');
		const secondDeployment = defaultNetwork(second.codegenRun!.deployment);
		expect(secondPackage.packageId, 'same source/publisher should hit the publish cache').toBe(
			firstPackage.packageId,
		);
		expect(secondPackage.mvrPlaceholder).toBe('@local-pkg/hello');
		expect(secondDeployment.packages.hello?.id).toBe(firstPackage.packageId);
		expect(secondDeployment.mvrOverrides.packages).toEqual({
			'@local-pkg/hello': firstPackage.packageId,
		});

		await emitStaticCodegen(staticOutputDir, secondEngine.members);
		const configPath = join(staticOutputDir, 'config.ts');
		const configSource = readFileSync(configPath, 'utf8');
		expect(configSource).toContain('requireId(dep, "@local-pkg/hello")');
		expect(configSource).not.toContain('@local/local-pkg-hello');
		expect(configSource).not.toContain('requireId(dep, "@local/hello")');

		(globalThis as Record<string, unknown>)['__DEVSTACK_DEPLOYMENT__'] =
			second.codegenRun!.deployment;
		try {
			const module = (await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`)) as {
				readonly config: {
					readonly packages: {
						readonly hello: { readonly mvr: string; readonly packageId: string };
					};
					readonly mvrOverrides: {
						readonly packages: Readonly<Record<string, string>>;
					};
				};
			};
			expect(module.config.packages.hello.mvr).toBe('@local-pkg/hello');
			expect(module.config.packages.hello.packageId).toBe(firstPackage.packageId);
			expect(module.config.mvrOverrides.packages).toEqual({
				'@local-pkg/hello': firstPackage.packageId,
			});
		} finally {
			delete (globalThis as Record<string, unknown>)['__DEVSTACK_DEPLOYMENT__'];
		}
	}, 360_000);
});
