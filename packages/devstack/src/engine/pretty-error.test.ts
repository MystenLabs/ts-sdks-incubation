// prettyError is the only thing standing between the user and a bare
// `devstack run failed: SuiError: ...` line that hides every actually-
// useful detail. The tests below pin the rendering contract so a future
// refactor of the wrapping chain (or a new tagged error shape) doesn't
// silently regress error legibility.

import { Cause } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { DockerError, SuiError, WalrusError } from '../engine/errors.js';
import { causeToJson, prettyError } from './pretty-error.js';

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

	it('renders an inner cause whose chain came through `cause:` on the tagged error (no flattened message)', () => {
		// Mirrors the post-stringify-cause-sweep pattern: callers stop
		// wrapping inner failures into their own `message` string and
		// instead pass the raw inner via the tagged error's `cause:`
		// field. Pretty-error walks the chain and surfaces every layer's
		// structured fields.
		const docker = new DockerError({
			op: 'docker run',
			message: 'pull access denied for mystenlabs/sui-tools',
			stderr: 'unauthorized',
			exitCode: 125,
		});
		const sui = new SuiError({
			phase: 'sui-up',
			message: 'failed to start sui localnet',
			cause: docker,
		});
		const rendered = prettyError(sui);
		// SuiError's `message` is the short summary the user reads
		// first; the DockerError underneath is what they action.
		expect(rendered).toContain('SuiError (sui-up): failed to start sui localnet');
		expect(rendered).toContain('DockerError (docker run): pull access denied');
		expect(rendered).toContain('exitCode: 125');
		expect(rendered).toContain('stderr: unauthorized');
		// Confirm we did NOT collapse the inner DockerError's message
		// into the SuiError's own message string — the structured
		// fields are reachable separately.
		expect(rendered).not.toContain('failed to start sui localnet: DockerError');
	});
});

describe('causeToJson', () => {
	it('preserves the full structured chain (DockerError wrapping a SuiError)', () => {
		const docker = new DockerError({
			op: 'docker run',
			message: 'pull access denied',
			stderr: 'unauthorized',
			exitCode: 125,
		});
		const sui = new SuiError({
			phase: 'sui-up',
			message: 'failed to start sui localnet',
			cause: docker,
		});
		const json = causeToJson(sui);
		expect(json._tag).toBe('SuiError');
		expect(json.phase).toBe('sui-up');
		expect(json.message).toBe('failed to start sui localnet');
		expect(json.cause).toBeDefined();
		expect(json.cause!._tag).toBe('DockerError');
		expect(json.cause!.op).toBe('docker run');
		expect(json.cause!.exitCode).toBe(125);
		expect(json.cause!.stderr).toBe('unauthorized');
	});

	it('walks Effect Cause.fail by recursing into the Fail reason', () => {
		const docker = new DockerError({
			op: 'docker pull',
			message: 'rate limit',
			exitCode: 1,
		});
		const cause = Cause.fail(docker);
		const json = causeToJson(cause);
		expect(json._tag).toBe('Cause');
		expect(json.reasons).toBeDefined();
		expect(json.reasons!.length).toBe(1);
		const first = json.reasons![0]!;
		expect(first._tag).toBe('Fail');
		expect(first.cause!._tag).toBe('DockerError');
		expect(first.cause!.exitCode).toBe(1);
	});

	it('truncates oversized stderr the same way prettyError does', () => {
		const big = 'y'.repeat(20_000);
		const docker = new DockerError({ op: 'docker run', message: 'oversized', stderr: big });
		const json = causeToJson(docker);
		expect(json.stderr).toContain('[truncated]');
		expect(json.stderr!.length).toBeLessThan(big.length);
	});

	it('falls back to {_tag, message} for plain Errors', () => {
		const json = causeToJson(new Error('boom'));
		expect(json._tag).toBe('Error');
		expect(json.message).toBe('boom');
	});

	it('returns the structured walk through JSON.stringify/parse round-trip', () => {
		// The whole point of the walker: a `--json`-mode consumer can
		// JSON.stringify the output and downstream code can match on
		// `_tag` / `exitCode` / `stderr` without parsing a multi-line
		// rendered string.
		const docker = new DockerError({
			op: 'docker run',
			message: 'denied',
			stderr: 'unauthorized',
			exitCode: 125,
		});
		const sui = new SuiError({ phase: 'sui-up', message: 'failed', cause: docker });
		const round = JSON.parse(JSON.stringify(causeToJson(sui))) as Record<string, unknown>;
		expect(round._tag).toBe('SuiError');
		expect((round.cause as Record<string, unknown>)._tag).toBe('DockerError');
		expect((round.cause as Record<string, unknown>).exitCode).toBe(125);
	});
});
