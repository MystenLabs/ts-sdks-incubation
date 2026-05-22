// CapabilityDecl — structurally extensible capability declarations.
//
// Built-ins register payload shapes through `DevstackCapabilityRegistry`.
// Plugin authors can module-augment that interface for custom capability
// kinds, while opaque custom declarations remain valid by structure.

import type { CodegenableDecl } from './codegenable.ts';
import type { CompositePrimitiveDecl } from './composite-primitive.ts';
import type { LifenessClassifierDecl } from './liveness-classifier.ts';
import type { RoutableDecl } from './routable.ts';
import type { SnapshotableDecl } from './snapshotable.ts';
import type { StrategyContributorDecl } from './strategy-contributor.ts';

/**
 * Capability kind registry. Module augmentation extends this interface:
 *
 * declare module '@mysten-incubation/devstack' {
 *   interface DevstackCapabilityRegistry {
 *     readonly 'health-check': { readonly url: string };
 *   }
 * }
 */
export interface DevstackCapabilityRegistry {
	readonly snapshotable: Omit<SnapshotableDecl, 'kind'>;
	readonly routable: Omit<RoutableDecl, 'kind'>;
	readonly codegenable: Omit<CodegenableDecl<unknown, string>, 'kind'>;
	readonly 'strategy-contributor': Omit<
		StrategyContributorDecl<string, unknown>,
		'kind'
	>;
	readonly 'liveness-classifier': Omit<LifenessClassifierDecl, 'kind'>;
	readonly 'composite-primitive': Omit<CompositePrimitiveDecl, 'kind'>;
}

export type CapabilityKind = keyof DevstackCapabilityRegistry & string;

type RegisteredCapabilityDecl<Kind extends CapabilityKind = CapabilityKind> = {
	readonly [K in Kind]: Readonly<{ readonly kind: K } & DevstackCapabilityRegistry[K]>;
}[Kind];

type ExtensionCapabilityDecl<
	Kind extends string = string,
	Payload extends object = object,
> = Readonly<{ readonly kind: Kind } & Payload>;

export type CapabilityDecl<Kind extends string = string> = string extends Kind
	? RegisteredCapabilityDecl | ExtensionCapabilityDecl
	: Kind extends CapabilityKind
		? RegisteredCapabilityDecl<Kind>
		: ExtensionCapabilityDecl<Kind>;

export type CapabilityPayloadFor<Kind extends string> = Kind extends CapabilityKind
	? DevstackCapabilityRegistry[Kind] & { readonly kind?: never }
	: object & { readonly kind?: never };

export type ExactCapabilityPayload<Kind extends string, Data extends object> =
	Kind extends CapabilityKind
		? Record<Exclude<keyof Data, keyof CapabilityPayloadFor<Kind>>, never>
		: unknown;
