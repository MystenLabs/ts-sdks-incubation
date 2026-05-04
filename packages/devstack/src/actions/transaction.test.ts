// Unit tests for `runTransaction`'s input-hash idempotence. The
// reconciler's hash-match skip predicate (combined with persisted state
// in the manifest) is what makes the action idempotent across cycles —
// we just verify that the action's `inputs` payload changes when any
// load-bearing knob does.

import { describe, expect, it, vi } from 'vitest';

import { runTransaction } from './transaction.js';

describe('runTransaction — inputs.buildHash captures build/signer/scope/needs', () => {
	it('produces the same buildHash for two calls with identical args', () => {
		const build = () => undefined;
		const a = runTransaction({ name: 'mint', signer: 'alice', build });
		const b = runTransaction({ name: 'mint', signer: 'alice', build });
		const hashA = (a.inputs as { buildHash: string }).buildHash;
		const hashB = (b.inputs as { buildHash: string }).buildHash;
		expect(hashA).toBe(hashB);
	});

	it('changes the buildHash when the build callback source changes', () => {
		const oldBuild = function buildVOne() {
			return undefined;
		};
		const newBuild = function buildVTwo() {
			return undefined;
		};
		// Different source bodies → different toString(); the parameter
		// names are different so even aggressive minifiers don't collapse
		// them.
		expect(oldBuild.toString()).not.toBe(newBuild.toString());
		const a = runTransaction({ name: 'mint', signer: 'alice', build: oldBuild });
		const b = runTransaction({ name: 'mint', signer: 'alice', build: newBuild });
		const hashA = (a.inputs as { buildHash: string }).buildHash;
		const hashB = (b.inputs as { buildHash: string }).buildHash;
		expect(hashA).not.toBe(hashB);
	});

	it('changes the buildHash when the signer changes', () => {
		const build = () => undefined;
		const a = runTransaction({ name: 'mint', signer: 'alice', build });
		const b = runTransaction({ name: 'mint', signer: 'bob', build });
		expect((a.inputs as { buildHash: string }).buildHash).not.toBe(
			(b.inputs as { buildHash: string }).buildHash,
		);
	});

	it('changes the buildHash when scope changes', () => {
		const build = () => undefined;
		const a = runTransaction({ name: 'mint', signer: 'alice', build });
		const b = runTransaction({ name: 'mint', signer: 'alice', build, scope: 'test-only' });
		expect((a.inputs as { buildHash: string }).buildHash).not.toBe(
			(b.inputs as { buildHash: string }).buildHash,
		);
	});

	it('changes the buildHash when needs change', () => {
		const build = () => undefined;
		const a = runTransaction({ name: 'mint', signer: 'alice', build });
		const b = runTransaction({ name: 'mint', signer: 'alice', build, needs: ['publish'] });
		expect((a.inputs as { buildHash: string }).buildHash).not.toBe(
			(b.inputs as { buildHash: string }).buildHash,
		);
	});
});

describe('runTransaction — action shape', () => {
	it('has no default getStatus (idempotence comes from input-hash + persisted state)', () => {
		const a = runTransaction({ name: 'mint', signer: 'alice', build: () => undefined });
		expect(a.getStatus).toBeUndefined();
	});

	it('forwards a custom getStatus when caller provides one', async () => {
		const probe = vi.fn(async () => ({ ok: true, detail: 'live' }));
		const a = runTransaction({
			name: 'mint',
			signer: 'alice',
			build: () => undefined,
			getStatus: probe,
		});
		expect(a.getStatus).toBe(probe);
	});

	it('threads scope onto the action when set', () => {
		const a = runTransaction({
			name: 'mint',
			signer: 'alice',
			build: () => undefined,
			scope: 'test-only',
		});
		expect(a.scope).toBe('test-only');
	});

	it('omits scope when not set (action-level default applies)', () => {
		const a = runTransaction({ name: 'mint', signer: 'alice', build: () => undefined });
		expect(a.scope).toBeUndefined();
	});

	it('sets runsAs to the signer name for same-signer serialization', () => {
		const a = runTransaction({ name: 'mint', signer: 'alice', build: () => undefined });
		expect(a.runsAs).toBe('alice');
	});
});
