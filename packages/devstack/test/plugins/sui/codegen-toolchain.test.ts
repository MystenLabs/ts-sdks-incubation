// The sui member declares the Move toolchain its bindings must be generated
// with, and the codegen orchestrator picks it up name-blind. Pins the seam
// at the pure layer: options → declaration → selection.

import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';

import { selectMoveToolchain } from '../../../src/orchestrators/codegen/bindings.ts';
import { makeCodegenable, makeStaticCodegen } from '../../../src/plugins/sui/codegen.ts';
import { FORK_IMAGE_ENV_VAR } from '../../../src/plugins/sui/mode/fork.ts';
import { checkHostCliAgainstPin } from '../../../src/plugins/sui/move-summary-runner.ts';
import { liveMoveToolchain, suiMoveToolchain } from '../../../src/plugins/sui/move-toolchain.ts';
import {
	DEFAULT_SUI_TOOLS_REF,
	SUI_TOOLS_REF_ENV_VAR,
} from '../../../src/plugins/sui/move/index.ts';

beforeEach(() => {
	vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, '');
	vi.stubEnv(FORK_IMAGE_ENV_VAR, '');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('suiMoveToolchain (stack-free declaration)', () => {
	it('follows the local image plan: bundled pin by default, config or env when set', () => {
		expect(suiMoveToolchain({ mode: 'local' })).toEqual({
			kind: 'sui-tools',
			suiToolsRef: DEFAULT_SUI_TOOLS_REF,
			explicit: false,
		});
		expect(suiMoveToolchain({ mode: 'local', suiToolsRef: 'r' })).toEqual({
			kind: 'sui-tools',
			suiToolsRef: 'r',
			explicit: true,
		});
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		expect(suiMoveToolchain({ mode: 'local' })).toEqual({
			kind: 'sui-tools',
			suiToolsRef: 'from-env',
			explicit: true,
		});
		// A caller Dockerfile is fed the same SUI_TOOLS_IMAGE, so the ref still applies.
		expect(suiMoveToolchain({ mode: 'local', image: { build: { context: '/c' } } })).toEqual({
			kind: 'sui-tools',
			suiToolsRef: 'from-env',
			explicit: true,
		});
	});

	it('declares nothing for a complete image devstack cannot reproduce stack-free', () => {
		vi.stubEnv(SUI_TOOLS_REF_ENV_VAR, 'from-env');
		// image.pull wins over the env var in the plan, so the env var must not
		// leak into codegen either.
		expect(suiMoveToolchain({ mode: 'local', image: { pull: 'me/sui:1' } })).toBeUndefined();
	});

	it('follows the fork image plan', () => {
		const fork = { mode: 'fork', upstream: 'testnet' } as const;
		expect(suiMoveToolchain(fork)).toBeUndefined(); // source build
		expect(suiMoveToolchain({ ...fork, suiToolsRef: 'r' })).toEqual({
			kind: 'sui-tools',
			suiToolsRef: 'r',
			explicit: true,
		});
		expect(suiMoveToolchain({ ...fork, image: { pull: 'me/sui-fork:1' } })).toBeUndefined();
		expect(
			suiMoveToolchain({ ...fork, suiToolsRef: 'r', image: { build: { context: '/c' } } }),
		).toEqual({ kind: 'sui-tools', suiToolsRef: 'r', explicit: true });
	});

	it('declares nothing for modes with no container', () => {
		expect(suiMoveToolchain({ mode: 'live', network: 'testnet' })).toBeUndefined();
		expect(
			suiMoveToolchain({ mode: 'local-rpc', rpcUrl: 'http://127.0.0.1:9000' }),
		).toBeUndefined();
	});
});

describe('liveMoveToolchain', () => {
	it('is the exact resolved image when the mode has one', () => {
		const image = { digest: 'sha256:abc', tag: 'devstack-build:x' };
		expect(liveMoveToolchain(image, { mode: 'local', suiToolsRef: 'r' })).toEqual({
			kind: 'image',
			image,
		});
	});

	it('falls back to the stack-free derivation when there is no container image', () => {
		expect(liveMoveToolchain(null, { mode: 'live', network: 'testnet' })).toBeUndefined();
	});
});

describe('sui codegen decls', () => {
	it('carry the toolchain on both the static and the live decl', () => {
		const toolchain = { kind: 'sui-tools', suiToolsRef: 'r', explicit: true } as const;
		const [staticDecl] = makeStaticCodegen(toolchain)();
		expect(staticDecl?.moveToolchain).toEqual(toolchain);
		const [plainStatic] = makeStaticCodegen(undefined)();
		expect(plainStatic?.moveToolchain).toBeUndefined();

		const live = makeCodegenable(
			{ mode: 'local', chainId: 'abc', rpc: 'http://127.0.0.1:9000', source: 'default' },
			{ kind: 'image', image: { digest: 'sha256:abc' } },
		);
		expect(live.moveToolchain).toEqual({ kind: 'image', image: { digest: 'sha256:abc' } });
	});
});

describe('selectMoveToolchain', () => {
	it.effect('returns undefined when no decl declares a toolchain', () =>
		Effect.gen(function* () {
			const picked = yield* selectMoveToolchain([
				{ emitterName: 'package' },
				{ emitterName: 'sui' },
			]);
			expect(picked).toBeUndefined();
		}),
	);

	it.effect('takes the toolchain from whichever decl declares it, and tolerates agreement', () =>
		Effect.gen(function* () {
			const toolchain = { kind: 'sui-tools', suiToolsRef: 'r1', explicit: true } as const;
			const picked = yield* selectMoveToolchain([
				{ emitterName: 'package' },
				{ emitterName: 'sui', moveToolchain: toolchain },
				{ emitterName: 'other', moveToolchain: { ...toolchain, explicit: false } },
			]);
			expect(picked).toEqual(toolchain);
		}),
	);

	it.effect('fails the cycle when two decls disagree, naming both', () =>
		Effect.gen(function* () {
			const error = yield* selectMoveToolchain([
				{
					emitterName: 'sui',
					moveToolchain: { kind: 'sui-tools', suiToolsRef: 'r1', explicit: true },
				},
				{ emitterName: 'other', moveToolchain: { kind: 'image', image: { digest: 'sha256:x' } } },
			]).pipe(Effect.flip);
			expect(error._tag).toBe('CodegenToolchainConflict');
			expect(error.established).toBe('sui-tools:r1');
			expect(error.conflicting).toBe('image:sha256:x');
			expect(error.emitters).toEqual(['sui', 'other']);
		}),
	);
});

describe('checkHostCliAgainstPin (host summary runner)', () => {
	const explicit = (suiToolsRef: string) =>
		({ kind: 'sui-tools', suiToolsRef, explicit: true }) as const;

	it("never questions the host CLI for devstack's own default pin or no toolchain", () => {
		expect(checkHostCliAgainstPin('sui 1.77.2-homebrew', undefined)).toEqual({ outcome: 'ok' });
		expect(
			checkHostCliAgainstPin('sui 1.77.2-homebrew', {
				kind: 'sui-tools',
				suiToolsRef: 'x',
				explicit: false,
			}),
		).toEqual({ outcome: 'ok' });
	});

	it('accepts a host CLI whose release matches an explicit release-tag pin', () => {
		expect(checkHostCliAgainstPin('sui 1.80.0-abc123def456', explicit('testnet-v1.80.0'))).toEqual({
			outcome: 'ok',
		});
		expect(checkHostCliAgainstPin('sui 1.78.1-homebrew\n', explicit('mainnet-v1.78.1'))).toEqual({
			outcome: 'ok',
		});
	});

	it('reports a verifiable release mismatch with both versions', () => {
		expect(
			checkHostCliAgainstPin('sui 1.77.2-homebrew', explicit('testnet-v1.80.0')),
		).toMatchObject({
			outcome: 'mismatch',
			expected: '1.80.0',
			host: '1.77.2',
		});
	});

	it('cannot verify SHA or channel refs, exact images, or an unreadable host version', () => {
		expect(
			checkHostCliAgainstPin(
				'sui 1.80.0-892d777c',
				explicit('892d777ccdf414f13b9421641831fc57462a8c6e'),
			),
		).toMatchObject({ outcome: 'unverifiable' });
		expect(checkHostCliAgainstPin('sui 1.80.0', explicit('testnet'))).toMatchObject({
			outcome: 'unverifiable',
		});
		expect(checkHostCliAgainstPin('', explicit('testnet-v1.80.0'))).toMatchObject({
			outcome: 'unverifiable',
		});
		expect(
			checkHostCliAgainstPin('sui 1.80.0', { kind: 'image', image: { digest: 'sha256:x' } }),
		).toMatchObject({ outcome: 'unverifiable', pinned: 'image sha256:x' });
	});
});
