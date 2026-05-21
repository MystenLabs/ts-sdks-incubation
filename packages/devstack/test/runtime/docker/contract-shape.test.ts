// Contract-shape pinning test.
//
// The `ContainerRuntime` capability is the L1 → L2 seam. PR1 widens
// the contract with image roundtrip operations plus explicit managed-
// managed-resource removal for snapshot restore/wipe/prune. This test pins:
//
//   - The new methods exist on the interface (type-level check).
//   - Their return shapes are the documented narrow envelope:
//       saveImage → Stream<Uint8Array, ContainerRuntimeError>
//       loadImage → Effect<ImageRef, ContainerRuntimeError>
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
	ExecOptions,
	ImageRef,
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
	pauseAndCommit: () => Effect.succeed<ImageRef>({ digest: 'sha256:committed' }),
	saveImage: () => Stream.empty,
	loadImage: () => Effect.succeed<ImageRef>({ digest: 'sha256:loaded' }),
	tagImage: () => Effect.void,
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
			const ref = yield* stubRuntime.loadImage(tar);
			expect(ref.digest).toBe('sha256:loaded');
		}),
	);

	it.effect('tagImage returns Effect<void, ContainerRuntimeError>', () =>
		Effect.gen(function* () {
			yield* stubRuntime.tagImage({ digest: 'sha256:abc' }, 'my-restored:latest');
			// no return; succeeded.
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
