import { Effect, type Scope } from 'effect';

import type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	EnsureContainerSpec,
} from '../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';

/** Sentinel `stack` value for containers / volumes / networks that are
 *  shared across a single app's stacks but isolated PER APP — the
 *  resource lives at app-scope, not stack-scope.
 *
 *  Current producer: the per-app sui chain-build container
 *  (`plugins/sui/chain-build-container.ts`) reuses one container
 *  across multiple stacks of the same app to keep the bind-mounted
 *  Move dep cache warm.
 *
 *  Lifecycle-prune + the prune CLI compare against this sentinel to
 *  decide whether a resource group is shared (pinned while any
 *  sibling stack under the same app is live) vs per-stack (pruned
 *  with its stack).
 *
 *  The vocabulary lives here alongside the `{ app, stack, plugin,
 *  role }` label tuple — managed-container.ts is the canonical
 *  owner. */
export const PER_APP_SHARED_STACK = '_per-app_' as const;

/** Coerce a composed string to a Docker network / DNS-alias-safe form
 *  (alphanumerics + hyphen). Identity strings are already network-safe;
 *  this guards the literal composition (`devstack-${app}-${stack}-…`). */
export const sanitizeAlias = (s: string): string => s.replace(/[^a-zA-Z0-9-]/g, '-');

export interface ManagedContainerIdentity {
	readonly app: string;
	readonly stack: string;
}

export interface ManagedContainerLabelOptions {
	readonly identity: ManagedContainerIdentity;
	readonly plugin: string;
	readonly role: string;
}

export const managedContainerLabels = (
	options: ManagedContainerLabelOptions,
): ContainerLabelTuple => ({
	app: options.identity.app,
	stack: options.identity.stack,
	plugin: options.plugin,
	role: options.role,
});

type ManagedContainerLabelInput =
	| { readonly labels: ContainerLabelTuple }
	| ManagedContainerLabelOptions;

export type EnsureManagedContainerOptions<E> = ManagedContainerLabelInput & {
	readonly runtime: ContainerRuntime;
	readonly spec: Omit<EnsureContainerSpec, 'labels'>;
	readonly mapError: (cause: ContainerRuntimeError) => E;
};

const labelsFrom = (input: ManagedContainerLabelInput): ContainerLabelTuple =>
	'labels' in input ? input.labels : managedContainerLabels(input);

export const ensureManagedContainer = <E>(
	options: EnsureManagedContainerOptions<E>,
): Effect.Effect<ContainerHandle, E, Scope.Scope> => {
	const labels = labelsFrom(options);
	return options.runtime
		.ensureContainer({
			...options.spec,
			labels,
		})
		.pipe(Effect.mapError(options.mapError));
};
