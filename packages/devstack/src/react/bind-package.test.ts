import { describe, expect, it, vi } from 'vitest';
import { bindPackage } from './bind-package.js';

describe('bindPackage', () => {
	it('curries the package option from the codegen-style builder', () => {
		const callRecorded: Array<unknown> = [];
		const createLobby = vi.fn((options: { package?: string; arguments?: unknown } = {}) => {
			callRecorded.push(options);
			return (tx: unknown) => ({ tx, options });
		});
		const bound = bindPackage({ createLobby }, '0xpkgLive');

		const builder = (bound.createLobby as (opts?: { arguments?: unknown }) => unknown)({
			arguments: [],
		});
		expect(builder).toBeDefined();
		expect(callRecorded).toHaveLength(1);
		expect(callRecorded[0]).toMatchObject({ package: '0xpkgLive', arguments: [] });
	});

	it('respects an explicit package: override at the call site', () => {
		const fn = vi.fn((opts: { package?: string } = {}) => opts);
		const bound = bindPackage({ fn }, '0xdefault');
		(bound.fn as (opts: { package: string }) => unknown)({ package: '0xexplicit' });
		expect(fn).toHaveBeenCalledWith({ package: '0xexplicit' });
	});

	it('passes through non-function exports unchanged', () => {
		const struct = { __struct: 'Lobby' };
		const bound = bindPackage({ struct }, '0xpkg');
		expect(bound.struct).toBe(struct);
	});

	it('passes through high-arity functions unchanged', () => {
		// Functions with arity > 1 aren't builder-shaped; assume they're
		// helpers (parsers, etc.) and leave them alone.
		const helper = (a: number, b: number) => a + b;
		const bound = bindPackage({ helper }, '0xpkg');
		expect(bound.helper).toBe(helper);
	});
});
