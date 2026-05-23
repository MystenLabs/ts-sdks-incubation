import { Effect, type Scope } from 'effect';

import type {
	ContainerHandle,
	ContainerRuntime,
	ContainerRuntimeError,
	EnsureContainerSpec,
} from '../../contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';
import { SpanAttr } from './observability/spans.ts';

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
		.pipe(
			Effect.mapError(options.mapError),
			Effect.withSpan('substrate.managedContainer.ensure', {
				attributes: {
					[SpanAttr.app]: labels.app,
					[SpanAttr.stack]: labels.stack,
					[SpanAttr.plugin]: labels.plugin,
					[SpanAttr.containerRole]: labels.role,
					[SpanAttr.containerName]: options.spec.name,
				},
			}),
		);
};
