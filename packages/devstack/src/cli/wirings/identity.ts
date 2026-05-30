// Shared identity types + helpers consumed by every verb wiring.
//
// `ResolvedIdentity` is the flat CLI-internal identity bundle (app /
// stack / network / runtimeRoot / stackRoot) that the `main.ts` argv
// pre-parser produces. Wirings consume it directly; they do NOT
// re-derive identity from process.env.

import { resolve as resolvePath } from 'node:path';

import { Cause, Effect } from 'effect';

import { appName, chainId, stackName } from '../../substrate/brand.ts';
import type { Identity } from '../../substrate/identity.ts';
import type { SupervisedStack } from '../../substrate/runtime/index.ts';
import { CliSupervisorLiveError } from '../../surfaces/cli/index.ts';
import { probeSupervisorPresence } from '../../surfaces/cli/commands/index.ts';

export interface ResolvedIdentity {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
	readonly runtimeRoot: string;
	readonly stacksRoot: string;
	readonly stackRoot: string;
	readonly rosterFile: string;
	/** The stack name the operator supplied EXPLICITLY via the `--stack`
	 *  flag or `$DEVSTACK_STACK` env var — `undefined` when neither was
	 *  given (i.e. `stack` above was cwd/package-inferred). Threaded from
	 *  `main.ts`'s argv pre-parser so the stack-precedence ladder below
	 *  can let an explicit flag/env beat a config-declared `stackName`. */
	readonly explicitStack?: string | undefined;
}

export const stackRootFor = (runtimeRoot: string, stack: string): string =>
	resolvePath(runtimeRoot, 'stacks', stack);

/** Stack-name precedence ladder, mirrored from the state-dir ladder in
 *  `main.ts` (`--state-dir` flag > `config.stateDir` > env > default):
 *
 *    explicit `--stack` / `$DEVSTACK_STACK` (`identity.explicitStack`)
 *      > config's `defineDevstack({ stackName })` (`stack.options.stackName`)
 *      > cwd/package inference (already folded into `identity.stack`,
 *        default `'main'`).
 *
 *  The explicit rung MUST win over a config `stackName` so an operator
 *  can run `pnpm dev` (default stack) and `pnpm test:e2e` (a `test`/`e2e`
 *  stack via `--stack`/env) against the SAME config concurrently — the
 *  two supervisors then claim distinct stack roots instead of colliding
 *  on `error: supervisor live for <app>/<stack>` (exit 40). `runStack`
 *  (`api/run-stack.ts`) already prefers its explicit option over
 *  `stack.options.stackName`; this keeps the CLI consistent with it. */
const effectiveStackName = (identity: ResolvedIdentity, stack?: SupervisedStack): string =>
	identity.explicitStack ?? stack?.options.stackName ?? identity.stack;

export const identityValueFor = (
	identity: ResolvedIdentity,
	stack?: SupervisedStack,
): Identity => ({
	app: appName(identity.app),
	stack: stackName(effectiveStackName(identity, stack)),
	chain: chainId(identity.network),
});

/** When a verb loads a config whose `stackName` may differ from the
 *  effective stack, re-derive the `ResolvedIdentity` against the
 *  effective stack so the stack-root, roster file, and command channel
 *  paths all target the same stack the supervisor uses. The effective
 *  stack follows the precedence ladder documented on `effectiveStackName`
 *  (explicit flag/env > config `stackName` > inferred), so an explicit
 *  `--stack`/`$DEVSTACK_STACK` is NOT overridden by `config.stackName`. */
export const resolvedIdentityForStack = (
	identity: ResolvedIdentity,
	stack: SupervisedStack,
): ResolvedIdentity => {
	const stackValue = effectiveStackName(identity, stack);
	const stackRoot = stackRootFor(identity.runtimeRoot, stackValue);
	return {
		...identity,
		stack: stackValue,
		stackRoot,
		rosterFile: resolvePath(stackRoot, 'roster.json'),
	};
};

/** Probe the roster file; if a supervisor is live, refuse the verb
 *  with a `CliSupervisorLiveError` carrying the operator hint. */
export const ensureNoLiveSupervisor = (
	identity: ResolvedIdentity,
	hint: string,
): Effect.Effect<void, CliSupervisorLiveError> =>
	Effect.gen(function* () {
		const presence = yield* probeSupervisorPresence(identity.rosterFile).pipe(
			Effect.catch(() => Effect.succeed({ live: false, pid: null, hostname: null })),
		);
		if (presence.live) {
			return yield* Effect.fail(
				new CliSupervisorLiveError({
					app: identity.app,
					stack: identity.stack,
					hint,
				}),
			);
		}
	});

export const findCliSupervisorLiveError = (
	cause: Cause.Cause<unknown>,
): CliSupervisorLiveError | null => {
	for (const reason of cause.reasons) {
		if (!Cause.isFailReason(reason)) continue;
		const error = reason.error;
		if (
			typeof error === 'object' &&
			error !== null &&
			(error as { readonly _tag?: unknown })._tag === 'CliSupervisorLiveError'
		) {
			return error as CliSupervisorLiveError;
		}
	}
	return null;
};
