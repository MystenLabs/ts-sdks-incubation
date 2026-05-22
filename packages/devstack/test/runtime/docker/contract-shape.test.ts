// Contract-shape pinning test.
//
// The `ContainerRuntime` capability is the L1 → L2 seam. PR1 widens
// the contract with image roundtrip operations plus explicit managed-
// managed-resource removal for snapshot restore/wipe/prune. This test pins:
//
//   - The new methods exist on the interface (type-level check).
//   - Their return shapes are the documented narrow envelope:
//       saveImage → Stream<Uint8Array, ContainerRuntimeError>
//       saveImages → Stream<Uint8Array, ContainerRuntimeError>
//       pauseAndCommit → Effect<TaggedImageRef, ContainerRuntimeError>
//       loadImage → Effect<LoadedImageBundle, ContainerRuntimeError>
//       tagImage  → Effect<void, ContainerRuntimeError>
//       pullImage → Effect<ImageRef, ContainerRuntimeError>
//       removeManaged* → Effect<number, ContainerRuntimeError>
//   - `exec` carries the optional `ExecOptions` knob.
//
// We don't spawn docker — we construct a hand-rolled contract impl
// and assert its surface. The real docker-backed implementation is
// covered by e2e tests.

import { Effect, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureNetworkSpec,
	ExecOptions,
	ImageRef,
	LoadedImageBundle,
	OneShotSpec,
	TaggedImageRef,
} from '../../../src/contracts/container-runtime.ts';

// Construct a stub ContainerRuntime that exercises every method
// signature. TypeScript catches contract drift; the runtime asserts
// the wiring landed.
const stubRuntime: ContainerRuntime = {
	ensureImage: () => Effect.succeed<ImageRef>({ digest: 'sha256:stub' }),
	pullImage: (ref) => Effect.succeed<ImageRef>({ digest: 'sha256:pulled', tag: ref }),
	ensureNetwork: () => Effect.succeed('net-stub'),
	ensureContainer: () =>
		Effect.succeed<ContainerHandle>({
			id: 'cid',
			name: 'cname',
			imageName: 'stub:latest',
			status: 'running',
			ips: [],
		}),
	exec: (_handle, _argv, _opts?: ExecOptions) =>
		Effect.succeed({ exitCode: 0, stdout: 'ok', stderr: '' }),
	runOneShot: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
	inspectByLabels: () => Effect.succeed([]),
	followLogs: () => Stream.empty,
	pause: () => Effect.void,
	pauseAndCommit: () =>
		Effect.succeed<TaggedImageRef>({
			digest: 'sha256:committed',
			tag: 'devstack-snapshot:committed',
		}),
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: () =>
		Effect.succeed<LoadedImageBundle>({
			refs: [{ digest: 'sha256:loaded', tag: 'devstack-snapshot:loaded' }],
		}),
	tagImage: () => Effect.void,
	removeImage: () => Effect.void,
	unpause: () => Effect.void,
	stop: () => Effect.void,
	sweepOrphans: () => Effect.succeed(0),
	removeManagedContainers: () => Effect.succeed(0),
	removeManagedImages: () => Effect.succeed(0),
	removeManagedNetworks: () => Effect.succeed(0),
	removeManagedVolumes: () => Effect.succeed(0),
};

const handle: ContainerHandle = {
	id: 'c',
	name: 'n',
	imageName: 'stub:latest',
	status: 'running',
	ips: [],
};

describe('ContainerRuntime contract surface', () => {
	it.effect('saveImage returns a Uint8Array stream projected to contract error', () =>
		Effect.gen(function* () {
			const ref: ImageRef = { digest: 'sha256:x', tag: 'foo:1' };
			const stream = stubRuntime.saveImage(ref);
			// Drain to assert it yields (empty array under the stub).
			const out = yield* Stream.runCollect(stream);
			expect(out).toEqual([]);
		}),
	);

	it.effect('loadImage accepts a Stream<Uint8Array, unknown>', () =>
		Effect.gen(function* () {
			const tar = Stream.make(new Uint8Array([1, 2, 3]));
			const bundle = yield* stubRuntime.loadImage(tar);
			expect(bundle.refs).toEqual([{ digest: 'sha256:loaded', tag: 'devstack-snapshot:loaded' }]);
		}),
	);

	it.effect('saveImages is required for deduplicated snapshot bundles', () =>
		Effect.gen(function* () {
			const refs: ReadonlyArray<TaggedImageRef> = [
				{ digest: 'sha256:a', tag: 'devstack-snapshot:a' },
				{ digest: 'sha256:b', tag: 'devstack-snapshot:b' },
			];
			const out = yield* Stream.runCollect(stubRuntime.saveImages(refs));
			expect(out).toEqual([]);
		}),
	);

	it.effect('tagImage returns Effect<void, ContainerRuntimeError>', () =>
		Effect.gen(function* () {
			yield* stubRuntime.tagImage({ digest: 'sha256:abc' }, 'my-restored:latest');
			// no return; succeeded.
		}),
	);

	it.effect('removeImage returns Effect<void, ContainerRuntimeError>', () =>
		Effect.gen(function* () {
			yield* stubRuntime.removeImage({ digest: 'sha256:abc', tag: 'devstack-snapshot:abc' });
		}),
	);

	it.effect('pullImage returns the pulled ImageRef', () =>
		Effect.gen(function* () {
			const ref = yield* stubRuntime.pullImage!('mysten/sui:devnet');
			expect(ref).toEqual({ digest: 'sha256:pulled', tag: 'mysten/sui:devnet' });
		}),
	);

	it.effect('exec carries optional ExecOptions', () =>
		Effect.gen(function* () {
			// All three forms compile + run.
			yield* stubRuntime.exec(handle, ['ls']);
			yield* stubRuntime.exec(handle, ['ls'], {});
			const r = yield* stubRuntime.exec(handle, ['ls'], {
				user: 'postgres',
				workdir: '/tmp',
				env: { FOO: 'bar' },
			});
			expect(r.exitCode).toBe(0);
		}),
	);

	it.effect('runOneShot carries an optional user for host bind-mount writers', () =>
		Effect.gen(function* () {
			const spec: OneShotSpec = {
				image: { digest: 'alpine:3.20', tag: 'alpine:3.20' },
				user: '1000:1000',
				argv: ['id'],
			};
			const r = yield* stubRuntime.runOneShot(spec);
			expect(r.exitCode).toBe(0);
		}),
	);

	it.effect('ensureNetwork carries optional subnet and gateway policy', () =>
		Effect.gen(function* () {
			const spec: EnsureNetworkSpec = {
				name: 'devstack-private-content-main-walrus-walrus-net',
				app: 'private-content',
				stack: 'main',
				subnet: '10.42.7.0/24',
				gateway: '10.42.7.1',
			};
			let captured: EnsureNetworkSpec | undefined;
			const runtime: ContainerRuntime = {
				...stubRuntime,
				ensureNetwork: (next) => {
					captured = next;
					return Effect.succeed('net-stub');
				},
			};

			yield* runtime.ensureNetwork(spec);

			expect(captured).toEqual(spec);
		}),
	);

	it.effect('explicit managed cleanup is distinct from orphan sweep', () =>
		Effect.gen(function* () {
			const removed = yield* stubRuntime.removeManagedContainers({
				app: 'app',
				stack: 'main',
			});
			expect(removed).toBe(0);
			expect(yield* stubRuntime.removeManagedImages({ app: 'app', stack: 'main' })).toBe(0);
			expect(yield* stubRuntime.removeManagedNetworks({ app: 'app', stack: 'main' })).toBe(0);
			expect(yield* stubRuntime.removeManagedVolumes({ app: 'app', stack: 'main' })).toBe(0);
		}),
	);
});
