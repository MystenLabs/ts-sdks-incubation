// `cli/cli-prompt` — severity-graded prompt helpers tests.
//
// Mocks `@clack/prompts` via `__setClackForTest` so we can drive the
// confirm / text paths without a real TTY. The TTY-detection path is
// exercised by toggling `process.stdin.isTTY` directly.
//
// Behaviour matrix covered:
//   - --yes short-circuits to `confirmed` without invoking clack
//   - --no-input on a TTY returns `non-interactive` with EX_CONFIRM_REQUIRED
//   - non-TTY stdin returns `non-interactive` with EX_USAGE
//   - clack returning the cancel symbol becomes `cancelled`
//   - clack returning false becomes `declined`
//   - clack returning true becomes `confirmed`
//   - tier-2 phrase guard requires exact match

import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	__setClackForTest,
	promptConfirm,
	promptTypeToConfirm,
} from './cli-prompt.js';
import { EX_CONFIRM_REQUIRED, EX_USAGE } from './exit-codes.js';

// Reusable mock for clack. We can swap `confirm` / `text` per test by
// reassigning `mock.confirm` and `mock.text` inline; `isCancel` checks
// the dedicated Symbol so we can distinguish cancellation from a falsy
// answer.
const CANCEL_SYMBOL = Symbol('test-clack-cancel');

interface MockClack {
	confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
	text: (opts: {
		message: string;
		placeholder?: string;
		validate?: (v: string | undefined) => string | Error | undefined;
	}) => Promise<string | symbol>;
	isCancel: (v: unknown) => boolean;
	note: (body: string, title?: string) => void;
}

const makeMockClack = (overrides: Partial<MockClack> = {}): MockClack => ({
	confirm: async () => true,
	text: async () => 'ok',
	isCancel: (v: unknown) => v === CANCEL_SYMBOL,
	note: () => undefined,
	...overrides,
});

const restoreStdin = (() => {
	const prev = process.stdin.isTTY;
	return () => {
		if (prev === undefined) {
			Object.defineProperty(process.stdin, 'isTTY', {
				value: undefined,
				configurable: true,
				writable: true,
			});
		} else {
			Object.defineProperty(process.stdin, 'isTTY', {
				value: prev,
				configurable: true,
				writable: true,
			});
		}
	};
})();

const setTTY = (isTTY: boolean): void => {
	Object.defineProperty(process.stdin, 'isTTY', {
		value: isTTY,
		configurable: true,
		writable: true,
	});
};

describe('cli/cli-prompt.promptConfirm', () => {
	afterEach(() => {
		__setClackForTest(undefined);
		restoreStdin();
	});

	it('--yes short-circuits to confirmed without invoking clack', async () => {
		let calls = 0;
		__setClackForTest(
			makeMockClack({
				confirm: async () => {
					calls += 1;
					return true;
				},
			}) as never,
		);
		const outcome = await Effect.runPromise(
			promptConfirm({ message: 'go?', yes: true, noInput: false }),
		);
		expect(outcome.kind).toBe('confirmed');
		expect(calls).toBe(0);
	});

	it('--no-input fails with EX_CONFIRM_REQUIRED on a TTY', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack() as never);
		const outcome = await Effect.runPromise(
			promptConfirm({ message: 'go?', yes: false, noInput: true }),
		);
		expect(outcome.kind).toBe('non-interactive');
		if (outcome.kind !== 'non-interactive') return;
		expect(outcome.exitCode).toBe(EX_CONFIRM_REQUIRED);
	});

	it('non-TTY stdin returns non-interactive with EX_USAGE', async () => {
		setTTY(false);
		__setClackForTest(makeMockClack() as never);
		const outcome = await Effect.runPromise(
			promptConfirm({ message: 'go?', yes: false, noInput: false }),
		);
		expect(outcome.kind).toBe('non-interactive');
		if (outcome.kind !== 'non-interactive') return;
		expect(outcome.exitCode).toBe(EX_USAGE);
	});

	it('clack-confirmed becomes confirmed', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack({ confirm: async () => true }) as never);
		const outcome = await Effect.runPromise(
			promptConfirm({ message: 'go?', yes: false, noInput: false }),
		);
		expect(outcome.kind).toBe('confirmed');
	});

	it('clack-declined becomes declined', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack({ confirm: async () => false }) as never);
		const outcome = await Effect.runPromise(
			promptConfirm({ message: 'go?', yes: false, noInput: false }),
		);
		expect(outcome.kind).toBe('declined');
	});

	it('clack-cancel becomes cancelled', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack({ confirm: async () => CANCEL_SYMBOL }) as never);
		const outcome = await Effect.runPromise(
			promptConfirm({ message: 'go?', yes: false, noInput: false }),
		);
		expect(outcome.kind).toBe('cancelled');
	});

	it('preview block is rendered as a clack note above the confirm', async () => {
		setTTY(true);
		const noteBodies: Array<string> = [];
		__setClackForTest(
			makeMockClack({
				confirm: async () => true,
				note: (body) => {
					noteBodies.push(body);
				},
			}) as never,
		);
		await Effect.runPromise(
			promptConfirm({
				message: 'go?',
				preview: ['a', 'b'],
				yes: false,
				noInput: false,
			}),
		);
		expect(noteBodies).toHaveLength(1);
		expect(noteBodies[0]).toBe('a\nb');
	});
});

describe('cli/cli-prompt.promptTypeToConfirm', () => {
	afterEach(() => {
		__setClackForTest(undefined);
		restoreStdin();
	});

	it('--yes short-circuits to confirmed', async () => {
		const outcome = await Effect.runPromise(
			promptTypeToConfirm({
				preview: ['x'],
				phrase: 'arena',
				message: 'type phrase',
				yes: true,
				noInput: false,
			}),
		);
		expect(outcome.kind).toBe('confirmed');
	});

	it('exact phrase match becomes confirmed', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack({ text: async () => 'arena' }) as never);
		const outcome = await Effect.runPromise(
			promptTypeToConfirm({
				preview: ['x'],
				phrase: 'arena',
				message: 'type phrase',
				yes: false,
				noInput: false,
			}),
		);
		expect(outcome.kind).toBe('confirmed');
	});

	it('cancel becomes cancelled', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack({ text: async () => CANCEL_SYMBOL }) as never);
		const outcome = await Effect.runPromise(
			promptTypeToConfirm({
				preview: ['x'],
				phrase: 'arena',
				message: 'type phrase',
				yes: false,
				noInput: false,
			}),
		);
		expect(outcome.kind).toBe('cancelled');
	});

	it('--no-input fails with EX_CONFIRM_REQUIRED', async () => {
		setTTY(true);
		__setClackForTest(makeMockClack() as never);
		const outcome = await Effect.runPromise(
			promptTypeToConfirm({
				preview: ['x'],
				phrase: 'arena',
				message: 'type phrase',
				yes: false,
				noInput: true,
			}),
		);
		expect(outcome.kind).toBe('non-interactive');
		if (outcome.kind !== 'non-interactive') return;
		expect(outcome.exitCode).toBe(EX_CONFIRM_REQUIRED);
	});
});
