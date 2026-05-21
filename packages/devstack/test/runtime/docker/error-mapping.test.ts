// Contract-projection test for the three new image-op typed errors.
//
// Architecture: the contract surface (`ContainerRuntimeError`) is a
// narrow closed-enum reason; the typed envelopes (`ImageSaveFailed`,
// `ImageLoadFailed`, `ImageTagFailed`) carry detail for advanced
// consumers. `toContractError` MUST surface a distinct reason for
// each new op so cascade-formatter / CLI envelopes don't conflate
// "save failed" with "load failed".

import { describe, expect, it } from 'vitest';

import {
	ContainerPortPublishConflict,
	ImageLoadFailed,
	ImageSaveFailed,
	ImageTagFailed,
} from '../../../src/runtime/docker/errors.ts';
import { toContractError } from '../../../src/runtime/docker/errors.ts';
import { wrapCreateError } from '../../../src/runtime/docker/wrap.ts';
import { CaptureError } from '../../../src/substrate/runtime/observability/subprocess-capture.ts';

describe('toContractError — new image ops', () => {
	it('ImageSaveFailed → image-save-failed', () => {
		const err = new ImageSaveFailed({
			ref: 'foo:1',
			detail: 'spawn failed',
			cause: new Error('boom'),
		});
		const projected = toContractError(err);
		expect(projected._tag).toBe('ContainerRuntimeError');
		expect(projected.reason).toBe('image-save-failed');
		expect(projected.detail).toContain('foo:1');
		expect(projected.detail).toContain('spawn failed');
	});

	it('ImageLoadFailed → image-load-failed (with stderr)', () => {
		const err = new ImageLoadFailed({
			detail: 'docker load exited 1',
			stderr: 'invalid tar header',
		});
		const projected = toContractError(err);
		expect(projected.reason).toBe('image-load-failed');
		expect(projected.detail).toContain('docker load exited 1');
		expect(projected.detail).toContain('invalid tar header');
	});

	it('ImageLoadFailed → image-load-failed (no stderr)', () => {
		const err = new ImageLoadFailed({ detail: 'no Loaded image line' });
		const projected = toContractError(err);
		expect(projected.reason).toBe('image-load-failed');
		// No `:` inflation when stderr is absent.
		expect(projected.detail).toBe('no Loaded image line');
	});

	it('ImageTagFailed → image-tag-failed', () => {
		const err = new ImageTagFailed({
			src: 'sha256:abc',
			dst: 'my-restored:latest',
			stderr: 'No such image: sha256:abc',
		});
		const projected = toContractError(err);
		expect(projected.reason).toBe('image-tag-failed');
		expect(projected.detail).toContain('sha256:abc');
		expect(projected.detail).toContain('my-restored:latest');
		expect(projected.detail).toContain('No such image');
	});

	it('ContainerPortPublishConflict → publish-port-conflict', () => {
		const err = new ContainerPortPublishConflict({
			name: 'devstack-wallet-wallet-sui-validator',
			stderr: 'Bind for 0.0.0.0:51001 failed: port is already allocated',
			exitCode: 125,
		});
		const projected = toContractError(err);
		expect(projected.reason).toBe('publish-port-conflict');
		expect(projected.detail).toContain('devstack-wallet-wallet-sui-validator');
		expect(projected.detail).toContain('port is already allocated');
	});

	it('wrapCreateError classifies Docker publish port conflicts distinctly from name collisions', () => {
		const err = wrapCreateError('devstack-wallet-wallet-sui-validator')(
			new CaptureError({
				op: 'docker.run',
				stdout: '',
				stderr: 'Bind for 0.0.0.0:51001 failed: port is already allocated',
				exitCode: 125,
			}),
		);
		expect(err._tag).toBe('ContainerPortPublishConflict');
	});
});

describe('typed error round-trip', () => {
	it('ImageSaveFailed has _tag and is catchTag-compatible', () => {
		const err = new ImageSaveFailed({ ref: 'r', detail: 'd' });
		expect(err._tag).toBe('ImageSaveFailed');
		expect(err.ref).toBe('r');
	});

	it('ImageLoadFailed has _tag', () => {
		const err = new ImageLoadFailed({ detail: 'd' });
		expect(err._tag).toBe('ImageLoadFailed');
	});

	it('ImageTagFailed has _tag', () => {
		const err = new ImageTagFailed({ src: 's', dst: 'd', stderr: '' });
		expect(err._tag).toBe('ImageTagFailed');
	});
});
