// Recovery scanner — regression coverage for Phase B3's net-new
// restore-pending recovery contract.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerRuntime,
	ContainerRuntimeError,
	ImageRef,
	TagImageOptions,
} from '../../../src/contracts/container-runtime.ts';
import {
	recoverPendingRestore,
	RESTORE_PENDING_FILE_NAME,
	RestorePendingRecoveryError,
} from '../../../src/orchestrators/snapshot/index.ts';
import { withTempRoot } from '../../helpers/with-temp-root.ts';

const stubRuntime = (
	overrides: Partial<ContainerRuntime> = {},
): ContainerRuntime =>
	({
		// Only `tagImage` is consulted by the recovery scanner. The
		// rest of the contract is filled with `Effect.die` so any
		// stray consultation surfaces a clear test failure.
		tagImage: (_src: ImageRef, _newTag: string, _opts?: TagImageOptions) => Effect.void,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...(overrides as any),
	}) as unknown as ContainerRuntime;

const writePendingMarkerRaw = (
	stackRoot: string,
	containers: ReadonlyArray<{
		readonly plugin: string;
		readonly role: string;
		readonly targetImageName: string;
		readonly stagedImageTag: string;
		readonly digest: string;
	}>,
	overrides: { readonly version?: number } = {},
): void => {
	mkdirSync(stackRoot, { recursive: true });
	writeFileSync(
		join(stackRoot, RESTORE_PENDING_FILE_NAME),
		`${JSON.stringify(
			{
				version: overrides.version ?? 2,
				snapshotId: '01HRESTORE000000000000000',
				artifactDir: '/dev/null/artifact',
				app: 'test-app',
				stack: 'main',
				network: 'sui:local',
				containers,
			},
			null,
			2,
		)}\n`,
	);
};

describe('recoverPendingRestore', () => {
	it.effect('returns noMarker when no pending marker exists', () =>
		withTempRoot('devstack-recover-pending', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const summary = yield* recoverPendingRestore(stackRoot, stubRuntime()).pipe(
					Effect.provide(NodeFileSystem.layer),
				);
				expect(summary.noMarker).toBe(true);
				expect(summary.snapshotId).toBeNull();
				expect(summary.inspected).toBe(0);
				expect(summary.recovered).toBe(0);
				expect(summary.stillPending).toEqual([]);
				expect(summary.markerCleared).toBe(false);
			}),
		),
	);

	it.effect('retags every outstanding entry and removes the marker on full recovery', () =>
		withTempRoot('devstack-recover-pending', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				writePendingMarkerRaw(stackRoot, [
					{
						plugin: 'postgres',
						role: 'db',
						targetImageName: 'devstack-build:pg-db',
						stagedImageTag: 'devstack-snapshot:restore-aaaa',
						digest: 'sha256:pg-db-digest',
					},
					{
						plugin: 'postgres',
						role: 'worker',
						targetImageName: 'devstack-build:pg-worker',
						stagedImageTag: 'devstack-snapshot:restore-bbbb',
						digest: 'sha256:pg-worker-digest',
					},
				]);
				const tagCalls: {
					readonly src: ImageRef;
					readonly newTag: string;
				}[] = [];
				const runtime = stubRuntime({
					tagImage: (src, newTag) =>
						Effect.sync(() => {
							tagCalls.push({ src, newTag });
						}),
				});
				const summary = yield* recoverPendingRestore(stackRoot, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);
				expect(summary.noMarker).toBe(false);
				expect(summary.snapshotId).toBe('01HRESTORE000000000000000');
				expect(summary.inspected).toBe(2);
				expect(summary.recovered).toBe(2);
				expect(summary.stillPending).toEqual([]);
				expect(summary.markerCleared).toBe(true);
				expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(false);
				// Happy path: staged tag is still in Docker, so the FIRST
				// attempt (tag + digest, resolved as tag by the contract)
				// succeeds and the digest fallback is never invoked.
				expect(tagCalls).toEqual([
					{
						src: { digest: 'sha256:pg-db-digest', tag: 'devstack-snapshot:restore-aaaa' },
						newTag: 'devstack-build:pg-db',
					},
					{
						src: { digest: 'sha256:pg-worker-digest', tag: 'devstack-snapshot:restore-bbbb' },
						newTag: 'devstack-build:pg-worker',
					},
				]);
			}),
		),
	);

	it.effect('keeps still-pending entries in the marker on per-entry retag failure', () =>
		withTempRoot('devstack-recover-pending', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				writePendingMarkerRaw(stackRoot, [
					{
						plugin: 'postgres',
						role: 'db',
						targetImageName: 'devstack-build:pg-db',
						stagedImageTag: 'devstack-snapshot:restore-aaaa',
						digest: 'sha256:pg-db-digest',
					},
					{
						plugin: 'postgres',
						role: 'worker',
						targetImageName: 'devstack-build:pg-worker',
						stagedImageTag: 'devstack-snapshot:restore-bbbb',
						digest: 'sha256:pg-worker-digest',
					},
				]);
				const runtime = stubRuntime({
					tagImage: (_src, newTag) =>
						newTag === 'devstack-build:pg-worker'
							? Effect.fail({
									_tag: 'ContainerRuntimeError',
									reason: 'image-tag-failed',
									detail: 'simulated',
								} as ContainerRuntimeError)
							: Effect.void,
				});
				const summary = yield* recoverPendingRestore(stackRoot, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);
				expect(summary.recovered).toBe(1);
				expect(summary.stillPending).toHaveLength(1);
				expect(summary.stillPending[0]?.role).toBe('worker');
				expect(summary.markerCleared).toBe(false);
				expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(true);
				const rewritten = JSON.parse(
					readFileSync(join(stackRoot, RESTORE_PENDING_FILE_NAME), 'utf8'),
				) as { readonly containers: ReadonlyArray<{ readonly role: string }> };
				expect(rewritten.containers).toHaveLength(1);
				expect(rewritten.containers[0]?.role).toBe('worker');
			}),
		),
	);

	it.effect('surfaces marker-decode error on corrupt marker', () =>
		withTempRoot('devstack-recover-pending', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				writeFileSync(join(stackRoot, RESTORE_PENDING_FILE_NAME), '{not json}');
				const exit = yield* Effect.exit(
					recoverPendingRestore(stackRoot, stubRuntime()).pipe(
						Effect.provide(NodeFileSystem.layer),
					),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				const error = Exit.findErrorOption(exit);
				expect(error._tag).toBe('Some');
				if (error._tag === 'Some') {
					expect(error.value).toBeInstanceOf(RestorePendingRecoveryError);
					const err = error.value as RestorePendingRecoveryError;
					expect(err.kind).toBe('marker-decode');
				}
			}),
		),
	);

	it.effect('recovers via digest when staging tag has been pruned', () =>
		withTempRoot('devstack-recover-pending', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				writePendingMarkerRaw(stackRoot, [
					{
						plugin: 'postgres',
						role: 'db',
						targetImageName: 'devstack-build:pg-db',
						stagedImageTag: 'devstack-snapshot:restore-aaaa',
						digest: 'sha256:pg-db-digest',
					},
				]);
				// Simulate `docker system prune` between crash and restart:
				// the staging tag is gone, so the FIRST attempt (which
				// carries the tag) fails with image-not-found; the SECOND
				// attempt (digest-only) succeeds. The scanner must fall
				// back to the digest and clear the marker.
				const tagCalls: {
					readonly src: ImageRef;
					readonly newTag: string;
				}[] = [];
				const runtime = stubRuntime({
					tagImage: (src, newTag) =>
						Effect.gen(function* () {
							tagCalls.push({ src, newTag });
							if (src.tag !== undefined) {
								return yield* Effect.fail({
									_tag: 'ContainerRuntimeError',
									reason: 'image-tag-failed',
									detail: `staging tag pruned: ${src.tag}`,
								} as ContainerRuntimeError);
							}
							return undefined;
						}),
				});
				const summary = yield* recoverPendingRestore(stackRoot, runtime).pipe(
					Effect.provide(NodeFileSystem.layer),
				);
				expect(summary.recovered).toBe(1);
				expect(summary.stillPending).toEqual([]);
				expect(summary.markerCleared).toBe(true);
				expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(false);
				// First attempt carried the (now-pruned) staging tag and
				// failed; second attempt carried only the digest and
				// succeeded.
				expect(tagCalls).toHaveLength(2);
				expect(tagCalls[0]?.src).toEqual({
					digest: 'sha256:pg-db-digest',
					tag: 'devstack-snapshot:restore-aaaa',
				});
				expect(tagCalls[1]?.src).toEqual({ digest: 'sha256:pg-db-digest' });
				expect(tagCalls[1]?.src.tag).toBeUndefined();
			}),
		),
	);

	it.effect(
		'treats an entry as recovered when both source attempts fail but the target already exists',
		() =>
			withTempRoot('devstack-recover-pending', (root) =>
				Effect.gen(function* () {
					const stackRoot = join(root, 'stack');
					writePendingMarkerRaw(stackRoot, [
						{
							plugin: 'postgres',
							role: 'db',
							targetImageName: 'devstack-build:pg-db',
							stagedImageTag: 'devstack-snapshot:restore-aaaa',
							digest: 'sha256:pg-db-digest',
						},
					]);
					// A previous recovery already promoted this entry to
					// `targetImageName`, then the supervise crashed before the
					// marker was rewritten. The two `removeSourceAfterTag`
					// promote attempts (staged tag, digest-with-remove) fail —
					// from the daemon's view those source REFS are gone — but
					// the EXPECTED image is still resident by content digest.
					// The scanner must probe the expected digest (no
					// `removeSourceAfterTag`), see it resolve, (re)point the
					// target name at it, and drop the marker rather than retag
					// forever.
					const tagCalls: {
						readonly src: ImageRef;
						readonly newTag: string;
						readonly removeSource: boolean;
					}[] = [];
					const runtime = stubRuntime({
						tagImage: (src, newTag, opts) =>
							Effect.gen(function* () {
								const removeSource = opts?.removeSourceAfterTag === true;
								tagCalls.push({ src, newTag, removeSource });
								// The identity probe is the ONLY call that omits
								// `removeSourceAfterTag` and addresses the expected
								// content digest with no staged tag. It must succeed.
								const isProbe = !removeSource;
								if (isProbe) return undefined; // expected image resident
								// Both promote attempts: source REFs gone.
								return yield* Effect.fail({
									_tag: 'ContainerRuntimeError',
									reason: 'image-tag-failed',
									detail: 'No such image (source promoted by prior recovery)',
								} as ContainerRuntimeError);
							}),
					});
					const summary = yield* recoverPendingRestore(stackRoot, runtime).pipe(
						Effect.provide(NodeFileSystem.layer),
					);
					expect(summary.recovered).toBe(1);
					expect(summary.stillPending).toEqual([]);
					expect(summary.markerCleared).toBe(true);
					expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(false);
					// Three runtime calls: staged-tag attempt, digest-only
					// fallback, then the identity probe. The probe addresses the
					// EXPECTED content digest (NOT the target name) so a name
					// collision cannot satisfy it, and omits removeSourceAfterTag.
					expect(tagCalls).toHaveLength(3);
					expect(tagCalls[2]).toEqual({
						src: { digest: 'sha256:pg-db-digest' },
						newTag: 'devstack-build:pg-db',
						removeSource: false,
					});
					expect(tagCalls[2]?.src.tag).toBeUndefined();
				}),
			),
	);

	it.effect(
		'keeps an entry pending when both source attempts fail and the target is absent',
		() =>
			withTempRoot('devstack-recover-pending', (root) =>
				Effect.gen(function* () {
					const stackRoot = join(root, 'stack');
					writePendingMarkerRaw(stackRoot, [
						{
							plugin: 'postgres',
							role: 'db',
							targetImageName: 'devstack-build:pg-db',
							stagedImageTag: 'devstack-snapshot:restore-aaaa',
							digest: 'sha256:pg-db-digest',
						},
					]);
					// Both source attempts fail AND the target probe fails too
					// — the canonical transient-daemon-error shape. The scanner
					// must NOT drop the marker: the entry stays pending so the
					// next supervise retries instead of silently losing the
					// in-flight restore.
					const tagCalls: {
						readonly src: ImageRef;
						readonly newTag: string;
					}[] = [];
					const runtime = stubRuntime({
						tagImage: (src, newTag) =>
							Effect.gen(function* () {
								tagCalls.push({ src, newTag });
								return yield* Effect.fail({
									_tag: 'ContainerRuntimeError',
									reason: 'daemon-unreachable',
									detail: 'transient daemon error',
								} as ContainerRuntimeError);
							}),
					});
					const summary = yield* recoverPendingRestore(stackRoot, runtime).pipe(
						Effect.provide(NodeFileSystem.layer),
					);
					expect(summary.recovered).toBe(0);
					expect(summary.stillPending).toHaveLength(1);
					expect(summary.stillPending[0]?.role).toBe('db');
					expect(summary.markerCleared).toBe(false);
					expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(true);
					const rewritten = JSON.parse(
						readFileSync(join(stackRoot, RESTORE_PENDING_FILE_NAME), 'utf8'),
					) as { readonly containers: ReadonlyArray<{ readonly role: string }> };
					expect(rewritten.containers).toHaveLength(1);
					expect(rewritten.containers[0]?.role).toBe('db');
					// All three runtime calls fired: both promote attempts plus
					// the identity probe (expected content digest → target
					// name); every one failed transiently.
					expect(tagCalls).toHaveLength(3);
					expect(tagCalls[2]).toEqual({
						src: { digest: 'sha256:pg-db-digest' },
						newTag: 'devstack-build:pg-db',
					});
				}),
			),
	);

	it.effect(
		'keeps an entry pending when the expected image is gone but an unrelated image collides on the target name',
		() =>
			withTempRoot('devstack-recover-pending', (root) =>
				Effect.gen(function* () {
					const stackRoot = join(root, 'stack');
					writePendingMarkerRaw(stackRoot, [
						{
							plugin: 'postgres',
							role: 'db',
							targetImageName: 'devstack-build:pg-db',
							stagedImageTag: 'devstack-snapshot:restore-aaaa',
							digest: 'sha256:pg-db-digest',
						},
					]);
					// The wrong-image hole: the snapshot's committed image was
					// pruned out-of-band (BOTH staged tag and the expected
					// content digest are gone), but a DIFFERENT, unrelated image
					// happens to sit at `targetImageName` (a managed build-image
					// name / shared base / pulled image that collides). A bare
					// name-existence probe (`docker tag <target> <target>`) would
					// succeed and FALSELY drop the marker as recovered — booting
					// the container from the wrong, un-restored image. The
					// digest-addressed probe must NOT be fooled: only a source
					// resolving to the EXPECTED digest may satisfy it, so the
					// entry stays pending.
					const tagCalls: {
						readonly src: ImageRef;
						readonly newTag: string;
					}[] = [];
					const runtime = stubRuntime({
						tagImage: (src, newTag) =>
							Effect.gen(function* () {
								tagCalls.push({ src, newTag });
								// Anything addressing the (collided) target NAME as a
								// source resolves — simulating an unrelated image at
								// that name. The expected content digest does NOT.
								const resolvesTargetName =
									src.tag === newTag || (src.tag === undefined && src.digest === newTag);
								if (resolvesTargetName) return undefined;
								return yield* Effect.fail({
									_tag: 'ContainerRuntimeError',
									reason: 'image-tag-failed',
									detail: `No such image: ${src.tag ?? src.digest}`,
								} as ContainerRuntimeError);
							}),
					});
					const summary = yield* recoverPendingRestore(stackRoot, runtime).pipe(
						Effect.provide(NodeFileSystem.layer),
					);
					// The expected image is genuinely absent, so the entry MUST
					// remain pending and the marker MUST survive — never dropped
					// on a mere name collision.
					expect(summary.recovered).toBe(0);
					expect(summary.stillPending).toHaveLength(1);
					expect(summary.stillPending[0]?.role).toBe('db');
					expect(summary.markerCleared).toBe(false);
					expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(true);
					// Three calls: staged-tag attempt, digest-with-remove
					// fallback, then the identity probe addressing the EXPECTED
					// digest (which the collided name does not satisfy).
					expect(tagCalls).toHaveLength(3);
					expect(tagCalls[2]).toEqual({
						src: { digest: 'sha256:pg-db-digest' },
						newTag: 'devstack-build:pg-db',
					});
				}),
			),
	);

	it.effect('warns and leaves a v1 (pre-upgrade) marker untouched', () =>
		withTempRoot('devstack-recover-pending', (root) =>
			Effect.gen(function* () {
				const stackRoot = join(root, 'stack');
				// Hand-roll a v1 marker — pre-upgrade entries had no
				// `digest` field. The scanner has no safe way to recover
				// these (digest is the only identity that survives
				// `docker system prune`), so it must skip with a warning
				// and leave the file on disk for operator review.
				writePendingMarkerRaw(
					stackRoot,
					[
						{
							plugin: 'postgres',
							role: 'db',
							targetImageName: 'devstack-build:pg-db',
							stagedImageTag: 'devstack-snapshot:restore-aaaa',
						} as unknown as {
							readonly plugin: string;
							readonly role: string;
							readonly targetImageName: string;
							readonly stagedImageTag: string;
							readonly digest: string;
						},
					],
					{ version: 1 },
				);
				const summary = yield* recoverPendingRestore(stackRoot, stubRuntime()).pipe(
					Effect.provide(NodeFileSystem.layer),
				);
				// Unsupported version is reported as "noMarker" from the
				// supervisor's perspective — there's nothing the scanner
				// can do, and we don't want to surface this as a fatal
				// boot failure.
				expect(summary.noMarker).toBe(true);
				expect(summary.snapshotId).toBeNull();
				expect(summary.inspected).toBe(0);
				expect(summary.recovered).toBe(0);
				expect(summary.stillPending).toEqual([]);
				expect(summary.markerCleared).toBe(false);
				// Marker file MUST still be on disk so the operator can
				// inspect / manually clean up.
				expect(existsSync(join(stackRoot, RESTORE_PENDING_FILE_NAME))).toBe(true);
			}),
		),
	);

});
