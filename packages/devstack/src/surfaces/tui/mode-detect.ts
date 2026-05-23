// Renderer mode detection.
//
// Architecture §11 + distilled/21-tui §Renderers: three renderer
// variants exist (ink dashboard, plain, silent). Selection rule:
//
//   1. Explicit `mode` argument wins (CLI flag or programmable
//      surface override).
//   2. Otherwise, auto-resolve by inspecting `process.stdout.isTTY`
//      (TTY → ink; non-TTY → plain).
//   3. `silent` is only selected when explicitly requested.
//
// NO_COLOR / FORCE_COLOR / TERM=dumb are handled by Ink/upstream —
// we don't override here (architecture invariant: defer to upstream
// color conventions).
//
// Pure module; the detection ITSELF doesn't run side effects — it
// reads `process.stdout.isTTY` once at call time but the surface
// machinery decides when to call it.

/** Closed set of renderer modes. Adding a mode is an architecture
 *  revision (see distilled/21-tui § Renderers). */
export type RendererMode = 'ink' | 'plain' | 'silent';

export interface ModeDetectInput {
	/** Explicit override from CLI flag / config / programmable
	 *  surface. `undefined` → auto-detect. */
	readonly requested?: RendererMode;
	/** Whether stdout is a TTY. Pass `process.stdout.isTTY` from the
	 *  caller; we keep this dependency-injectable for testability. */
	readonly stdoutIsTty: boolean;
}

/**
 * Resolve the active renderer mode.
 *
 *   requested      | stdoutIsTty | result
 *   ---------------+-------------+--------
 *   'ink'          |  any        | 'ink'
 *   'plain'        |  any        | 'plain'
 *   'silent'       |  any        | 'silent'
 *   undefined      |  true       | 'ink'
 *   undefined      |  false      | 'plain'
 *
 * Note: the `'ink'` explicit override on a non-TTY is allowed and is
 * the operator's problem (e.g. invoked under a TTY-emulating
 * wrapper). The auto path NEVER picks `'ink'` for a non-TTY.
 */
export const resolveMode = (input: ModeDetectInput): RendererMode => {
	if (input.requested) return input.requested;
	return input.stdoutIsTty ? 'ink' : 'plain';
};

/**
 * Detect-from-process convenience for callers that don't need the
 * pure `resolveMode` separation. Reads `process.stdout.isTTY` once.
 */
export const detectMode = (requested?: RendererMode): RendererMode =>
	resolveMode({
		requested,
		stdoutIsTty: Boolean(process.stdout.isTTY),
	});
