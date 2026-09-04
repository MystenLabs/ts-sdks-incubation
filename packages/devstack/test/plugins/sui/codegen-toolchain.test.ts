// The sui member declares the Move toolchain its bindings must be generated
// with, and the codegen orchestrator picks it up name-blind. Pins the seam
// end to end at the pure layer: options → decl → selection → summary input.

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { selectMoveToolchain } from '../../../src/orchestrators/codegen/bindings.ts';
import { makeCodegenable, makeStaticCodegen } from '../../../src/plugins/sui/codegen.ts';
import { suiMoveToolchain } from '../../../src/plugins/sui/move/index.ts';

describe('sui Move toolchain declaration', () => {
	it('declares the configured suiToolsRef for the container-backed modes only', () => {
		expect(suiMoveToolchain({ mode: 'local', suiToolsRef: 'r' })).toEqual({ suiToolsRef: 'r' });
		expect(suiMoveToolchain({ mode: 'fork', upstream: 'testnet', suiToolsRef: 'r' })).toEqual({
			suiToolsRef: 'r',
		});
		expect(suiMoveToolchain({ mode: 'local' })).toBeUndefined();
		expect(suiMoveToolchain({ mode: 'local', suiToolsRef: '  ' })).toBeUndefined();
		expect(suiMoveToolchain({ mode: 'live', network: 'testnet' })).toBeUndefined();
		expect(
			suiMoveToolchain({ mode: 'local-rpc', rpcUrl: 'http://127.0.0.1:9000' }),
		).toBeUndefined();
	});

	it('carries the toolchain on both the static and the live codegen decl', () => {
		const [staticDecl] = makeStaticCodegen({ suiToolsRef: 'r' })();
		expect(staticDecl?.moveToolchain).toEqual({ suiToolsRef: 'r' });
		const [plainStatic] = makeStaticCodegen(undefined)();
		expect(plainStatic?.moveToolchain).toBeUndefined();

		const live = makeCodegenable(
			{ mode: 'local', chainId: 'abc', rpc: 'http://127.0.0.1:9000', source: 'default' },
			{ suiToolsRef: 'r' },
		);
		expect(live.moveToolchain).toEqual({ suiToolsRef: 'r' });
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

	it.effect('takes the toolchain from whichever decl declares it, first wins', () =>
		Effect.gen(function* () {
			const picked = yield* selectMoveToolchain([
				{ emitterName: 'package' },
				{ emitterName: 'sui', moveToolchain: { suiToolsRef: 'r1' } },
				{ emitterName: 'other', moveToolchain: { suiToolsRef: 'r2' } },
			]);
			expect(picked).toEqual({ suiToolsRef: 'r1' });
		}),
	);
});
