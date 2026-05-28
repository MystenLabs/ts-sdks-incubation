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
}

export const stackRootFor = (runtimeRoot: string, stack: string): string =>
	resolvePath(runtimeRoot, 'stacks', stack);

export const identityValueFor = (
	identity: ResolvedIdentity,
	stack?: SupervisedStack,
): Identity => ({
	app: appName(identity.app),
	stack: stackName(stack?.options.stackName ?? identity.stack),
	chain: chainId(identity.network),
});

/** When a verb loads a config whose `stackName` may differ from the
 *  CLI flag's stack, re-derive the `ResolvedIdentity` against the
 *  config-named stack so the stack-root, roster file, and command
 *  channel paths all target the same stack the supervisor uses. */
export const resolvedIdentityForStack = (
	identity: ResolvedIdentity,
	stack: SupervisedStack,
): ResolvedIdentity => {
	const stackValue = stack.options.stackName ?? identity.stack;
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
