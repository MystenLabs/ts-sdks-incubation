// Unit tests for the sui Snapshotable contribution.
//
// The snapshot decl is the bridge between the plugin's mode-resolved
// containers / on-disk state and the snapshot orchestrator's per-stack
// tar. These tests pin the `preRestore` identity record so a refactor
// can't silently break the cross-mode refusal.
//
// Load-bearing case (mirrors walrus's `mode`-in-identity pattern):
// container `local` mode (committed chain-state in the writable layer)
// and `local-rpc` mode (caller-owned external RPC, no container) can
// resolve to the SAME chain id. The `mode` discriminator folded into
// `preRestore` is what makes the identity guard refuse a container-`local`
// snapshot restored against a `local-rpc` stack (and vice versa) at an
// identical chain id — otherwise the guard sees only `{kind, chain}` and
// a chain-state restore against an external RPC is a silent no-op.

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { makeSnapshotable } from '../../../src/plugins/sui/snapshot.ts';

// Mirror the orchestrator's identity-string derivation (see
// `orchestrators/snapshot/service.ts` `stableIdentityString` +
// `normalizeIdentityValue`): keys sorted recursively, then JSON. The
// guard compares this exact string per plugin key, so equality here is
// equivalent to "the identity guard agrees".
const normalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, normalize(nested)]),
		);
	}
	return value;
};

/** Run the decl's `preRestore` hook and derive the stable identity
 *  string the orchestrator would compare. */
const identityOf = (...args: Parameters<typeof makeSnapshotable>): string => {
	const decl = makeSnapshotable(...args);
	if (decl.preRestore === undefined) throw new Error('expected a preRestore identity record');
	return JSON.stringify(normalize(Effect.runSync(decl.preRestore)));
};

describe('sui makeSnapshotable — identity guard', () => {
	it('refuses a cross-mode restore at an identical chain id (local vs local-rpc)', () => {
		// Same chain id (a caller wrapping their own localnet reports the
		// same `sui:localnet` as the in-container validator), different
		// mode. The folded `mode` key forces the identity strings apart so
		// the guard refuses before any destructive mutation.
		const containerLocal = identityOf('local', 'app', 'main', 'sui:localnet');
		const externalRpc = identityOf('local-rpc', 'app', 'main', 'sui:localnet');
		expect(containerLocal).not.toBe(externalRpc);
	});

	it('accepts a restore within the same mode at the same chain id (local → local)', () => {
		const a = identityOf('local', 'app', 'main', 'sui:localnet');
		const b = identityOf('local', 'app', 'main', 'sui:localnet');
		expect(a).toBe(b);
	});

	it('accepts a restore within the same mode at the same chain id (local-rpc → local-rpc)', () => {
		const a = identityOf('local-rpc', 'app', 'main', 'sui:localnet');
		const b = identityOf('local-rpc', 'app', 'main', 'sui:localnet');
		expect(a).toBe(b);
	});

	it('refuses across every distinct mode pair at one shared chain id', () => {
		const chain = 'sui:localnet';
		const modes = ['local', 'local-rpc', 'live', 'fork'] as const;
		const strings = modes.map((mode) => identityOf(mode, 'app', 'main', chain));
		// Every mode produces a distinct identity string at the same chain.
		expect(new Set(strings).size).toBe(modes.length);
	});

	it('still refuses on a genuine chain-id mismatch within one mode', () => {
		const localnet = identityOf('local', 'app', 'main', 'sui:localnet');
		const testnet = identityOf('local', 'app', 'main', 'sui:testnet');
		expect(localnet).not.toBe(testnet);
	});

	it('every mode tags the record with kind "sui-chain" and its own mode', () => {
		for (const mode of ['local', 'local-rpc', 'live', 'fork'] as const) {
			const decl = makeSnapshotable(mode, 'app', 'main', 'sui:localnet');
			const record = Effect.runSync(decl.preRestore!);
			expect(record.kind).toBe('sui-chain');
			expect(record.mode).toBe(mode);
			expect(record.chain).toBe('sui:localnet');
		}
	});
});
