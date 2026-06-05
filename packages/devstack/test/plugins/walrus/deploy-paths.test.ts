// Regression tests for `walrusDeployMountPaths` — the bind-mount
// triple shared by the walrus deploy one-shot + storage nodes.
//
// The previous implementation walked up exactly three `dirname`
// levels with no guard. A shorter `deployOutputDirHostPath` (or one
// whose ancestor chain doesn't extend to a real stack root) would
// silently return `/` and the bind-mount would publish the host root
// into the container. Review fix phase 22a switched to explicit
// `stackRoot` injection plus an assertion that the deploy dir is a
// descendant of `stackRoot`.

import { describe, expect, it } from 'vitest';

import { walrusDeployMountPaths } from '../../../src/plugins/walrus/deploy-paths.ts';

describe('walrusDeployMountPaths', () => {
	it('publishes stackRoot as the bind-mount source and re-derives the in-container path', () => {
		const result = walrusDeployMountPaths({
			stackRoot: '/tmp/devstack',
			deployOutputDirHostPath: '/tmp/devstack/walrus/walrus/deploy',
			mountTarget: '/opt/walrus/runtime',
		});
		expect(result.sourceHostPath).toBe('/tmp/devstack');
		expect(result.mountTarget).toBe('/opt/walrus/runtime');
		// The output dir is computed off `relative(stackRoot, deployDir)` joined into the
		// container mount target — same shape the deploy CLI's `--output-dir` expects.
		expect(result.outputDirInContainer).toBe('/opt/walrus/runtime/walrus/walrus/deploy');
	});

	it('rejects a deployOutputDirHostPath outside stackRoot', () => {
		// Sibling top-level path — the previous walk-up implementation would
		// have silently rebased the mount source onto the deploy dir's own
		// great-grandparent, decoupling it from the stack root.
		expect(() =>
			walrusDeployMountPaths({
				stackRoot: '/tmp/devstack',
				deployOutputDirHostPath: '/somewhere/else/walrus/deploy',
				mountTarget: '/opt/walrus/runtime',
			}),
		).toThrow(/must be a descendant of stackRoot/);
	});

	it('rejects a deployOutputDirHostPath equal to stackRoot', () => {
		// Degenerate input — `relative()` returns an empty string. The
		// previous implementation would have computed
		// `dirname(dirname(dirname(stackRoot)))` which collapses upward.
		expect(() =>
			walrusDeployMountPaths({
				stackRoot: '/tmp/devstack',
				deployOutputDirHostPath: '/tmp/devstack',
				mountTarget: '/opt/walrus/runtime',
			}),
		).toThrow(/must be a descendant of stackRoot/);
	});

	it('rejects relative-traversal escape attempts', () => {
		// Belt-and-suspenders — `path.relative` produces a `..`-prefixed
		// string for traversal escapes.
		expect(() =>
			walrusDeployMountPaths({
				stackRoot: '/tmp/devstack/walrus/walrus/deploy',
				deployOutputDirHostPath: '/tmp/devstack',
				mountTarget: '/opt/walrus/runtime',
			}),
		).toThrow(/must be a descendant of stackRoot/);
	});

	it('accepts a deep descendant deploy dir', () => {
		const result = walrusDeployMountPaths({
			stackRoot: '/home/dev/.devstack/main',
			deployOutputDirHostPath: '/home/dev/.devstack/main/walrus/walrus/deploy',
			mountTarget: '/opt/walrus/runtime',
		});
		expect(result.sourceHostPath).toBe('/home/dev/.devstack/main');
		expect(result.outputDirInContainer).toBe('/opt/walrus/runtime/walrus/walrus/deploy');
	});
});
