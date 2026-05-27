// Action plugin — typed errors.
//
// Distilled doc 16-action.md "Failure modes": signing failure routes
// through `PublishError({ phase: 'publish-tx' })`. The rewrite splits
// the user-facing action error from `package`'s `PublishError` because
// action-specific phases (build, sign, parse) carry different semantics
// — `build` here is the user-supplied transaction-builder Effect,
// `sign` is the `signAndExecute` invocation, `parse` covers downstream
// receipt projection.
//
// Per architecture §Effect, errors are plain interfaces with a `_tag`
// discriminator; `Effect.catchTag` / `catchTags` match on the literal.

/** Phases for `ActionError`. Closed sum — adding a phase requires
 *  editing this file (and the plugin doc's catalog).
 *
 *  Phase semantics:
 *   - `discriminator`   — `opts.discriminator` Effect evaluation failed.
 *                         User-code defect or yielded upstream raised.
 *   - `build`           — `opts.body`'s build phase (the user-supplied
 *                         Effect) failed before producing a transaction.
 *   - `sign`            — signing / submit transport failed (signer
 *                         refused, RPC unreachable, finality timeout).
 *                         This is `account.signAndExecute`'s error
 *                         channel; it does NOT cover on-chain failures.
 *   - `execute-failed`  — transaction was delivered + executed by the
 *                         validator but the on-chain execution failed
 *                         (the `$kind: 'FailedTransaction'` variant of
 *                         `account.signAndExecute`'s return value).
 *   - `parse`           — the action's receipt projection (digest /
 *                         objectChanges) was malformed.
 *   - `verify`          — verify probe authoritatively raised (transient
 *                         is masked by the lenient probe — does NOT raise
 *                         this).
 */
export type ActionPhase =
	| 'discriminator'
	| 'build'
	| 'sign'
	| 'execute-failed'
	| 'parse'
	| 'verify';

/** Single tagged action error. */
export interface ActionError {
	readonly _tag: 'ActionError';
	readonly phase: ActionPhase;
	/** Symbolic action name (the user-declared `action.name`). Flows
	 *  into the cache key namespace and the TUI row title. */
	readonly actionName: string;
	readonly message: string;
	readonly cause?: unknown;
}

export const actionError = (
	phase: ActionPhase,
	parts: Omit<ActionError, '_tag' | 'phase'>,
): ActionError => ({ _tag: 'ActionError', phase, ...parts });

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const ACTION_ERROR_TAGS = ['ActionError'] as const;
