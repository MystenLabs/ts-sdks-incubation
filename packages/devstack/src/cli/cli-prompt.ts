// Severity-graded interactive prompts for destructive CLI operations.
//
// Three behaviours (per `notes/cli-redesign.md` §4.3):
//
//   - Tier 1 (moderate) — prompt by default on TTY, `--yes` skips,
//     `--no-input` fails with EX_USAGE. Used by `snapshot delete`,
//     `prune` (the interactive picker already gates), and `wipe` (the
//     plain confirm path).
//
//   - Tier 2 (severe) — show a preview block then make the operator
//     TYPE the stack name. `--yes` bypasses. `--no-input` fails.
//     Used by `wipe --also-upstream-cache` (the only Tier 2 today).
//
// Layered over `@clack/prompts` so the look matches the broader npm
// CLI ecosystem (vite, astro, ms-create, gh — all use clack-style
// boxes). The clack module is dynamically imported to keep top-level
// CLI startup fast and to allow injecting a mock from tests without
// pulling in the real ANSI machinery.
//
// `isCancel` from clack is the sentinel returned when the user hits
// Ctrl-C inside a prompt. We translate it to `EX_USAGE` because that's
// the closest sysexits match — the operator explicitly declined.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect } from 'effect';
import { EX_CONFIRM_REQUIRED, EX_USAGE, type ExitCode } from './exit-codes.js';
import { inputDisabled } from './envelope.js';

/** Resolved outcome of a single prompt. */
export type PromptOutcome =
	| { readonly kind: 'confirmed' }
	| { readonly kind: 'declined' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'non-interactive'; readonly reason: string; readonly exitCode: ExitCode };

/** Detect whether stdin is a TTY. Set as a function so tests can stub
 *  `process.stdin.isTTY` and re-evaluate at each call site. */
export const stdinIsTTY = (): boolean => process.stdin.isTTY === true;

/** Lazy loader for `@clack/prompts`. Returns `undefined` when the
 *  module is unavailable (e.g. in a sandbox / test runner that stubs
 *  the import). Production callers always succeed. */
export const loadClack = async (): Promise<typeof import('@clack/prompts') | undefined> => {
	try {
		const mod = await import('@clack/prompts');
		return mod;
	} catch {
		return undefined;
	}
};

/** Module-level override so tests can swap the real clack for an
 *  in-memory mock without monkey-patching node_modules. Returns the
 *  override when set, otherwise falls back to `loadClack`. */
let clackOverride: typeof import('@clack/prompts') | undefined;
export const __setClackForTest = (mock: typeof import('@clack/prompts') | undefined): void => {
	clackOverride = mock;
};
const resolveClack = async (): Promise<typeof import('@clack/prompts') | undefined> => {
	if (clackOverride !== undefined) return clackOverride;
	return loadClack();
};

/** Tier 1 confirmation — plain y/N prompt with a preview block above.
 *
 *  Behaviour matrix:
 *    --yes               -> { kind: 'confirmed' } (no prompt rendered)
 *    --no-input          -> { kind: 'non-interactive', exitCode: EX_USAGE }
 *    non-TTY stdin       -> { kind: 'non-interactive', exitCode: EX_USAGE }
 *    user picks 'no'     -> { kind: 'declined' }
 *    user picks 'yes'    -> { kind: 'confirmed' }
 *    user Ctrl-C's       -> { kind: 'cancelled' } */
export const promptConfirm = (input: {
	readonly message: string;
	readonly preview?: ReadonlyArray<string>;
	readonly yes: boolean;
	readonly noInput: boolean;
}): Effect.Effect<PromptOutcome> =>
	Effect.gen(function* () {
		if (input.yes) return { kind: 'confirmed' } as const;
		if (inputDisabled({ noInput: input.noInput })) {
			return {
				kind: 'non-interactive',
				reason: '--no-input was set (or DEVSTACK_NO_INPUT=1)',
				exitCode: EX_CONFIRM_REQUIRED,
			} as const;
		}
		if (!stdinIsTTY()) {
			return {
				kind: 'non-interactive',
				reason: 'stdin is not a TTY (CI / piped input) — pass --yes to bypass',
				exitCode: EX_USAGE,
			} as const;
		}
		const clack = yield* Effect.promise(() => resolveClack());
		if (clack === undefined) {
			return {
				kind: 'non-interactive',
				reason: '@clack/prompts is not installed; pass --yes to bypass',
				exitCode: EX_USAGE,
			} as const;
		}
		// Render the preview as a clack note block so the user sees the
		// list of side effects above the prompt.
		if (input.preview !== undefined && input.preview.length > 0) {
			try {
				clack.note(input.preview.join('\n'), 'About to proceed');
			} catch {
				// best-effort — non-fatal if note rendering fails
			}
		}
		const answer = yield* Effect.promise(() =>
			clack.confirm({
				message: input.message,
				initialValue: false,
			}),
		);
		if (clack.isCancel(answer)) {
			return { kind: 'cancelled' } as const;
		}
		return answer ? ({ kind: 'confirmed' } as const) : ({ kind: 'declined' } as const);
	});

/** Tier 2 confirmation — render the preview, then require the operator
 *  to type back the supplied phrase (typically the stack name). This
 *  is the highest-friction guard, reserved for full-stack-teardown
 *  with-upstream-cache. Same `--yes` / `--no-input` semantics as
 *  Tier 1; the only difference is the phrase-matching step. */
export const promptTypeToConfirm = (input: {
	readonly preview: ReadonlyArray<string>;
	readonly phrase: string;
	readonly message: string;
	readonly yes: boolean;
	readonly noInput: boolean;
}): Effect.Effect<PromptOutcome> =>
	Effect.gen(function* () {
		if (input.yes) return { kind: 'confirmed' } as const;
		if (inputDisabled({ noInput: input.noInput })) {
			return {
				kind: 'non-interactive',
				reason: '--no-input was set (or DEVSTACK_NO_INPUT=1)',
				exitCode: EX_CONFIRM_REQUIRED,
			} as const;
		}
		if (!stdinIsTTY()) {
			return {
				kind: 'non-interactive',
				reason: 'stdin is not a TTY (CI / piped input) — pass --yes to bypass',
				exitCode: EX_USAGE,
			} as const;
		}
		const clack = yield* Effect.promise(() => resolveClack());
		if (clack === undefined) {
			return {
				kind: 'non-interactive',
				reason: '@clack/prompts is not installed; pass --yes to bypass',
				exitCode: EX_USAGE,
			} as const;
		}
		try {
			clack.note(input.preview.join('\n'), 'About to proceed (Tier 2)');
		} catch {
			// best-effort
		}
		const typed = yield* Effect.promise(() =>
			clack.text({
				message: input.message,
				placeholder: input.phrase,
				validate: (v: string | undefined) =>
					(v ?? '') === input.phrase
						? undefined
						: `Type '${input.phrase}' exactly to confirm`,
			}),
		);
		if (clack.isCancel(typed)) {
			return { kind: 'cancelled' } as const;
		}
		return typed === input.phrase
			? ({ kind: 'confirmed' } as const)
			: ({ kind: 'declined' } as const);
	});
