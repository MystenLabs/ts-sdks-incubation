// prettyError is the only thing standing between the user and a bare
// `devstack run failed: SuiError: ...` line that hides every actually-
// useful detail. The tests below pin the rendering contract so a future
// refactor of the wrapping chain (or a new tagged error shape) doesn't
// silently regress error legibility.

import { Cause } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { DockerError, SuiError, WalrusError } from '../primitives/errors.js';
import { prettyError } from './pretty-error.js';

describe('prettyError', () => {
	it('renders a tagged error with op + stderr + exitCode', () => {
		const docker = new DockerError({
			op: 'docker run',
			message: 'docker run — exit 125 — stderr: pull access denied for mystenlabs/sui-tools',
			stderr: 'pull access denied for mystenlabs/sui-tools',
			exitCode: 125,
		});
		const rendered = prettyError(docker);
		expect(rendered).toContain('DockerError (docker run):');
		expect(rendered).toContain('exitCode: 125');
		expect(rendered).toContain('stderr: pull access denied for mystenlabs/sui-tools');
	});

	it('recurses into the cause chain so wrappers expose root details', () => {
		const root = new DockerError({
			op: 'docker run',
			message: 'docker run — exit 125 — stderr: pull access denied',
			stderr: 'pull access denied for mystenlabs/sui-tools',
			exitCode: 125,
		});
		const wrapped = new SuiError({
			phase: 'sui-up',
			message: 'failed to start sui localnet container',
			cause: root,
		});
		const rendered = prettyError(wrapped);
		expect(rendered).toContain('SuiError (sui-up): failed to start sui localnet container');
		expect(rendered).toContain('caused by:');
		expect(rendered).toContain('DockerError (docker run):');
		expect(rendered).toContain('exitCode: 125');
		expect(rendered).toContain('stderr: pull access denied for mystenlabs/sui-tools');
	});

	it('chains three levels deep without flattening the middle hop', () => {
		const docker = new DockerError({
			op: 'docker pull',
			message: 'docker pull — exit 1 — stderr: rate limit',
			stderr: 'rate limit',
			exitCode: 1,
		});
		const walrus = new WalrusError({
			phase: 'image',
			message: 'failed to pull walrus image',
			cause: docker,
		});
		const outer = new SuiError({
			phase: 'walrus-bootstrap',
			message: 'walrus dependency unavailable',
			cause: walrus,
		});
		const rendered = prettyError(outer);
		expect(rendered).toContain('SuiError (walrus-bootstrap)');
		expect(rendered).toContain('WalrusError (image)');
		expect(rendered).toContain('DockerError (docker pull)');
		expect(rendered).toContain('rate limit');
	});

	it('falls back to Error rendering with stack for plain Errors', () => {
		const err = new Error('boom');
		const rendered = prettyError(err);
		expect(rendered).toContain('Error: boom');
		expect(rendered).toContain('pretty-error.test.ts');
	});

	it('renders Effect Cause.fail by recursing into the Fail reason', () => {
		const docker = new DockerError({
			op: 'docker run',
			message: 'docker run — exit 125 — stderr: image not found',
			stderr: 'image not found',
			exitCode: 125,
		});
		const cause = Cause.fail(docker);
		const rendered = prettyError(cause);
		expect(rendered).toContain('DockerError (docker run)');
		expect(rendered).toContain('image not found');
		expect(rendered).toContain('exitCode: 125');
	});

	it('renders Cause.die by recursing into the defect', () => {
		const cause = Cause.die(new Error('panicked'));
		const rendered = prettyError(cause);
		expect(rendered).toContain('Error: panicked');
	});

	it('renders unknown values via String', () => {
		expect(prettyError(42)).toBe('42');
		expect(prettyError('boom')).toBe('boom');
	});

	it('truncates oversized stderr to keep the render bounded', () => {
		const big = 'x'.repeat(20_000);
		const docker = new DockerError({
			op: 'docker run',
			message: 'oversized',
			stderr: big,
			exitCode: 1,
		});
		const rendered = prettyError(docker);
		expect(rendered).toContain('[truncated]');
		expect(rendered.length).toBeLessThan(big.length);
	});
});
