// The sui member's input identity folds the EFFECTIVE sui-tools ref, so a
// changed env override marks snapshots stale like a config change would.

import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';

import { suiInputIdentity } from '../../../src/plugins/sui/index.ts';
import { SUI_TOOLS_REF_ENV_VAR } from '../../../src/plugins/sui/move/index.ts';

const identity = (opts: Parameters<typeof suiInputIdentity>[0]) =>
	JSON.stringify(suiInputIdentity(opts));

beforeEach(() => {
	vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('suiInputIdentity and the sui-tools ref', () => {
	it('is unchanged for a default stack with no ref anywhere', () => {
		const before = identity({ mode: 'local' });
		expect(before).not.toContain('suiToolsRef');
		expect(identity({ mode: 'fork', upstream: 'testnet' })).not.toContain('suiToolsRef');
	});

	it('changes when the env ref is set, in both container modes', () => {
		const local = identity({ mode: 'local' });
		const fork = identity({ mode: 'fork', upstream: 'testnet' });
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(identity({ mode: 'local' })).not.toBe(local);
		expect(identity({ mode: 'fork', upstream: 'testnet' })).not.toBe(fork);
		// Config and env naming the same ref are the same identity.
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
		expect(identity({ mode: 'local', suiToolsRef: 'from-env' })).toBe(
			(vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env'), identity({ mode: 'local' })),
		);
	});

	it('ignores the env ref when image.pull names the whole image', () => {
		const pulled = identity({ mode: 'local', image: { pull: 'me/sui:1' } });
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(identity({ mode: 'local', image: { pull: 'me/sui:1' } })).toBe(pulled);
	});

	it('never carries a ref for modes without a container', () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(identity({ mode: 'live', network: 'testnet' })).not.toContain('from-env');
	});
});
