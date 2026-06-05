// Shared `ContainerRuntime` stub for unit tests.
//
// ~20 unit-test files independently hand-rolled a FULL `ContainerRuntime`
// literal where most/every method is `Effect.die('<method> not used')`,
// with a handful of real overrides. Adding a single contract method (for
// example `inspectImageDigest`) meant editing every one of those literals
// by hand — a fragile fanout.
//
// `makeContainerRuntimeStub` collapses that to ONE place: it returns a
// full `ContainerRuntime` with every method defaulting to a clear
// `Effect.die('<method> not used in this test')` (or `Stream.die` for the
// streaming `saveImages` channel), shallow-merged with the caller's real
// overrides. A future contract method addition is now a one-line default
// added here, not a 20-file fanout.
//
// The default is intentionally `Effect.die`/`Stream.die`: a stub method an
// individual test does NOT override is one that test's code path must
// never reach — reaching it is a test bug, and a die surfaces it loudly.
// Tests that need a method to be a no-op pass that override explicitly.
//
// NOTE: this is for the SIMPLE all-unused fanout stubs only. Specialized
// recording harnesses (snapshot capture/restore) keep their own stub
// construction so their recording channels stay legible.

import { Effect, Stream } from 'effect';

import type { ContainerRuntime } from '../../src/contracts/container-runtime.ts';

/**
 * Build a full `ContainerRuntime` whose every method dies with a clear
 * "<method> not used in this test" message, shallow-merged with
 * `overrides`. Type it exactly to the current contract: a new method on
 * `ContainerRuntime` becomes a TypeScript error here until a default is
 * added — a single edit instead of a per-file fanout.
 *
 * `pullImage` is optional on the contract and is intentionally NOT in the
 * default set (mirrors the hand-rolled stubs, which omitted it and only
 * supplied it via `overrides` when a test exercised the pull path).
 */
export const makeContainerRuntimeStub = (
	overrides: Partial<ContainerRuntime> = {},
): ContainerRuntime => ({
	ensureImage: () => Effect.die('ensureImage not used in this test'),
	ensureNetwork: () => Effect.die('ensureNetwork not used in this test'),
	ensureContainer: () => Effect.die('ensureContainer not used in this test'),
	exec: () => Effect.die('exec not used in this test'),
	runOneShot: () => Effect.die('runOneShot not used in this test'),
	inspectByLabels: () => Effect.die('inspectByLabels not used in this test'),
	pauseAndCommit: () => Effect.die('pauseAndCommit not used in this test'),
	saveImages: () => Stream.die('saveImages not used in this test'),
	loadImage: () => Effect.die('loadImage not used in this test'),
	tagImage: () => Effect.die('tagImage not used in this test'),
	removeImage: () => Effect.die('removeImage not used in this test'),
	inspectImageDigest: () => Effect.die('inspectImageDigest not used in this test'),
	stop: () => Effect.die('stop not used in this test'),
	removeManagedContainers: () => Effect.die('removeManagedContainers not used in this test'),
	removeManagedImages: () => Effect.die('removeManagedImages not used in this test'),
	removeManagedNetworks: () => Effect.die('removeManagedNetworks not used in this test'),
	removeManagedVolumes: () => Effect.die('removeManagedVolumes not used in this test'),
	...overrides,
});
