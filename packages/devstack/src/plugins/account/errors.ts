// Account plugin — typed errors.
//
// Distilled-doc finding (12-account.md "Acquisition vs signing error
// split" invariant): two error families must not be mixed. Acquisition
// errors (keystore unreadable, faucet exhausted, scheme unsupported)
// surface as `AccountAcquireError`; signing errors (gRPC failure,
// finality wait, locked-shared-object) surface as `AccountSignError`.
// Mixing them breaks downstream `catchTag` boundaries — the engine's
// pretty-cause walker also dispatches on `_tag`, so any merger here
// would force a renderer-side branch on `phase` instead.
//
// Effect v4: plain interface + `_tag` literal discriminator (no
// subclassing). The architecture's per-plugin tagged-error convention
// (12-account.md "Promote the sign/execute error to the same
// tagged-error class shape") is honored here — both errors are
// uniform-shape, the cause walker handles them by `_tag`.

/** Phases for `AccountAcquireError`. Closed sum — adding a phase
 *  requires editing this list AND the cause-walker's display table. */
export type AccountAcquirePhase =
	| 'validate-name'
	| 'validate-funding'
	| 'decode-inline'
	| 'bind-signer'
	| 'bind-impersonation-slot'
	| 'generate-keypair'
	| 'persist-keypair'
	| 'read-persisted-keypair'
	| 'restrict-permissions'
	| 'derive-address'
	| 'unsupported-scheme'
	| 'await-chain-ready'
	| 'fund-default'
	| 'fund-cross-cutting'
	| 'register';

/** Account acquisition error — raised by the variant resolvers and
 *  the funding pass. Carries the per-variant + per-phase column. */
export interface AccountAcquireError {
	readonly _tag: 'AccountAcquireError';
	readonly phase: AccountAcquirePhase;
	readonly accountName: string;
	readonly variant: AccountVariantKind;
	readonly message: string;
	readonly hint?: string;
	readonly cause?: unknown;
}

export const accountAcquireError = (
	parts: Omit<AccountAcquireError, '_tag'>,
): AccountAcquireError => ({ _tag: 'AccountAcquireError', ...parts });

/** Phases for `AccountSignError`. Strictly transport / lifecycle
 *  failures along the sign-and-execute pipeline — `signAndExecute`
 *  itself returns a `SignAndExecuteResult` discriminated union for
 *  the on-chain outcome (success vs `FailedTransaction`), so
 *  on-chain failures are NOT in this phase set. The impersonation
 *  refusal lives here so a synchronous throw maps cleanly onto an
 *  async catch boundary when callers wrap the resolved-account
 *  signer in `Effect.try`.
 *
 *   - `build-tx`         — transaction serialisation threw before
 *                          signing.
 *   - `sign`             — the signer rejected / threw.
 *   - `submit`           — `executeTransaction` transport failure
 *                          (RPC unreachable, network error). The
 *                          response never arrived.
 *   - `no-digest`        — `executeTransaction` returned a response
 *                          that violates the SDK envelope contract
 *                          (`$kind` missing OR `Transaction.digest`
 *                          missing OR `FailedTransaction.digest`
 *                          missing). Protocol violation, not a
 *                          transport failure — kept distinct so
 *                          `'submit'` keeps a single failure-kind
 *                          (per §2 "phases describe steps, not
 *                          failure kinds").
 *   - `await-finality`   — `waitForTransaction` failed AFTER a
 *                          submit-success; the digest exists but the
 *                          finality wait broke.
 *   - `dependent-package-not-found`
 *   - `lease-acquire`
 *   - `impersonation-bypass-attempt`
 */
export type AccountSignPhase =
	| 'build-tx'
	| 'sign'
	| 'submit'
	| 'no-digest'
	| 'await-finality'
	| 'dependent-package-not-found'
	| 'lease-acquire'
	| 'impersonation-bypass-attempt';

/** Account sign/execute error — raised by the per-account signer's
 *  `signAndExecute` / `signTransaction` / `signPersonalMessage`
 *  surfaces.
 *
 *  Distilled-doc opportunity: today's implementation projects this to
 *  JSON specially. Promoting to the uniform-shape interface here lets
 *  the cause walker treat it like every other plugin's tagged error;
 *  the special JSON-projection case can go away. */
export interface AccountSignError {
	readonly _tag: 'AccountSignError';
	readonly phase: AccountSignPhase;
	readonly accountName: string;
	readonly address: string;
	readonly message: string;
	readonly cause?: unknown;
}

export const accountSignError = (parts: Omit<AccountSignError, '_tag'>): AccountSignError => ({
	_tag: 'AccountSignError',
	...parts,
});

/** Account variant discriminator. Mirrors the user-facing
 *  `AccountOptions` shape's `kind:` field. */
export type AccountVariantKind = 'ephemeral' | 'signer' | 'impersonate';

/** Union of every error an Account-plugin caller may encounter. */
export type AccountError = AccountAcquireError | AccountSignError;

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const ACCOUNT_ERROR_TAGS: ReadonlyArray<AccountError['_tag']> = [
	'AccountAcquireError',
	'AccountSignError',
] as const;
