// Plugin authoring substrate.
//
// Public plugin authors use `definePlugin({ id, dependsOn, start })`.
// This module lowers that shape to the current engine's `StackMember`
// contract so the supervisor, lifecycle graph, snapshots, routing, and
// codegen stay on the existing path while the authoring API changes.

import type { CapabilityDecl } from '../contracts/capability-decl.ts';
import type { LiftedSiblingKey } from '../substrate/lifted-sibling.ts';
import type { AnyTag, Tag } from '../substrate/tag.ts';
import { defineTag } from '../substrate/tag.ts';
import { MEMBER_BRAND, type StackMember } from '../substrate/plugin.ts';
import type { Effect } from 'effect';

const resourceBrand: unique symbol = Symbol('devstack.resource');
const pluginBrand: unique symbol = Symbol('devstack.plugin');
const resourceValue: unique symbol = Symbol('devstack.resource.value');

export interface ResourceRef<Id extends string, Value = unknown> {
	readonly id: Id;
	readonly [resourceBrand]: true;
	readonly [resourceValue]?: () => Value;
}

export type AnyResourceRef = ResourceRef<string, unknown>;

export type ResourceIdOf<R extends AnyResourceRef> = R['id'];

export type ResourceValueOf<R extends AnyResourceRef> =
	R extends ResourceRef<string, infer Value> ? Value : never;

export const defineId = <const Id extends string>(id: Id): Id => id;

export const resource = <const Id extends string, Value = unknown>(
	id: Id,
): ResourceRef<Id, Value> =>
	({
		id,
		[resourceBrand]: true,
	}) as ResourceRef<Id, Value>;

export const isResourceRef = (value: unknown): value is AnyResourceRef =>
	typeof value === 'object' &&
	value !== null &&
	(value as { readonly [resourceBrand]?: true })[resourceBrand] === true;

type ResourceTagOf<R extends AnyResourceRef> = Tag<ResourceIdOf<R>, ResourceValueOf<R>>;

type TagsOf<Refs extends readonly AnyResourceRef[]> = {
	readonly [K in keyof Refs]: Refs[K] extends AnyResourceRef ? ResourceTagOf<Refs[K]> : never;
};

export type DependencyInput =
	| AnyResourceRef
	| readonly AnyResourceRef[]
	| Readonly<Record<string, AnyResourceRef>>;

export type DependencyList<Input> = Input extends readonly AnyResourceRef[]
	? Input
	: Input extends AnyResourceRef
		? readonly [Input]
		: Input extends Readonly<Record<string, AnyResourceRef>>
			? ReadonlyArray<Input[keyof Input]>
			: readonly [];

type ResolvedDependencyList<Dependencies extends readonly AnyResourceRef[]> = {
	readonly [K in keyof Dependencies]: Dependencies[K] extends AnyResourceRef
		? ResourceValueOf<Dependencies[K]>
		: never;
};

type ResolvedDependencyObject<Dependencies extends Readonly<Record<string, AnyResourceRef>>> = {
	readonly [K in keyof Dependencies]: Dependencies[K] extends AnyResourceRef
		? ResourceValueOf<Dependencies[K]>
		: never;
};

export type ResolvedDependencies<Input> = [Input] extends [undefined]
	? undefined
	: [Input] extends [readonly AnyResourceRef[]]
		? ResolvedDependencyList<Input>
		: [Input] extends [AnyResourceRef]
			? ResourceValueOf<Input>
			: [Input] extends [Readonly<Record<string, AnyResourceRef>>]
				? ResolvedDependencyObject<Input>
				: never;

export interface StartContext {}

type PluginStart<DependsOn extends DependencyInput | undefined> = (
	ctx: StartContext,
	deps: ResolvedDependencies<DependsOn>,
) => Effect.Effect<unknown, unknown, unknown>;

type StartValue<Start> =
	Start extends (...args: never) => Effect.Effect<infer Value, unknown, unknown> ? Value : never;

export type CapabilitySource<
	Value,
	Caps extends ReadonlyArray<CapabilityDecl>,
> = Caps | ((ctx: { readonly value: Value; readonly runtime: import('../substrate/plugin.ts').AcquireContext }) => Caps);

interface PluginSpecBase<
	Id extends string,
	DependsOn extends DependencyInput | undefined,
	Start extends PluginStart<DependsOn>,
	Caps extends ReadonlyArray<CapabilityDecl>,
	Siblings extends ReadonlyArray<LiftedSiblingKey>,
> {
	readonly id: Id;
	readonly kind: import('../substrate/lifecycle.ts').PluginKind;
	readonly rebootCost?: import('../substrate/lifecycle.ts').RebootCost;
	readonly watch?: import('../substrate/plugin.ts').WatchDecl;
	readonly start: Start;
	readonly capabilities?: CapabilitySource<StartValue<Start>, Caps>;
	readonly liftedSiblings?: Siblings;
	readonly displayHint?: unknown;
	readonly errorContributions?: import('../substrate/plugin.ts').PluginErrorContribution[];
}

export type PluginSpec<
	Id extends string,
	DependsOn extends DependencyInput | undefined,
	Start extends PluginStart<DependsOn>,
	Caps extends ReadonlyArray<CapabilityDecl>,
	Siblings extends ReadonlyArray<LiftedSiblingKey>,
> = PluginSpecBase<Id, DependsOn, Start, Caps, Siblings> & {
	readonly dependsOn?: DependsOn;
};

export interface Plugin<
	Id extends string,
	Value,
	Needs extends readonly AnyResourceRef[],
	Caps extends ReadonlyArray<CapabilityDecl>,
	Siblings extends ReadonlyArray<LiftedSiblingKey> = readonly [],
> extends StackMember<ResourceTagOf<ResourceRef<Id, Value>>, TagsOf<Needs>, Caps, Siblings>,
		ResourceRef<Id, Value> {
	readonly [pluginBrand]: true;
	readonly dependsOn: Needs;
}

export type AnyPlugin = Plugin<
	string,
	unknown,
	readonly AnyResourceRef[],
	ReadonlyArray<CapabilityDecl>,
	ReadonlyArray<LiftedSiblingKey>
>;

export const isPlugin = (value: unknown): value is AnyPlugin =>
	typeof value === 'object' &&
	value !== null &&
	(value as { readonly [pluginBrand]?: true })[pluginBrand] === true;

export const dependencyList = <Input extends DependencyInput | undefined>(
	dependsOn: Input,
): DependencyList<Input> => {
	if (dependsOn === undefined) {
		return [] as unknown as DependencyList<Input>;
	}
	if (Array.isArray(dependsOn)) {
		return dependsOn as unknown as DependencyList<Input>;
	}
	if (isResourceRef(dependsOn)) {
		return [dependsOn] as unknown as DependencyList<Input>;
	}
	return Object.values(dependsOn) as unknown as DependencyList<Input>;
};

const tagForResource = <R extends AnyResourceRef>(ref: R): ResourceTagOf<R> => {
	if (isPlugin(ref)) {
		return ref.provides as ResourceTagOf<R>;
	}
	return defineTag<ResourceIdOf<R>, ResourceValueOf<R>>(ref.id, ref.id);
};

const uniqueResourceRefs = (refs: readonly AnyResourceRef[]): readonly AnyResourceRef[] => {
	const seen = new Set<string>();
	const unique: AnyResourceRef[] = [];
	for (const ref of refs) {
		if (seen.has(ref.id)) {
			continue;
		}
		seen.add(ref.id);
		unique.push(ref);
	}
	return unique;
};

const resolveDependencyValues = <Input extends DependencyInput | undefined>(
	dependsOn: Input,
	read: (resource: DependencyList<Input>[number]) => unknown,
): ResolvedDependencies<Input> => {
	const readAny = (resourceRef: AnyResourceRef) =>
		read(resourceRef as DependencyList<Input>[number]);

	if (dependsOn === undefined) {
		return undefined as ResolvedDependencies<Input>;
	}
	if (Array.isArray(dependsOn)) {
		return dependsOn.map((resourceRef) => readAny(resourceRef)) as ResolvedDependencies<Input>;
	}
	if (isResourceRef(dependsOn)) {
		return readAny(dependsOn) as ResolvedDependencies<Input>;
	}
	return Object.fromEntries(
		Object.entries(dependsOn).map(([key, resourceRef]) => [key, readAny(resourceRef)]),
	) as ResolvedDependencies<Input>;
};

export function definePlugin<
	const Id extends string,
	const DependsOn extends DependencyInput,
	const Start extends PluginStart<DependsOn> = PluginStart<DependsOn>,
	const Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
	const Siblings extends ReadonlyArray<LiftedSiblingKey> = readonly [],
>(
	spec: PluginSpecBase<Id, DependsOn, Start, Caps, Siblings> & { readonly dependsOn: DependsOn },
): Plugin<Id, StartValue<Start>, DependencyList<DependsOn>, Caps, Siblings>;
export function definePlugin<
	const Id extends string,
	const Start extends PluginStart<undefined> = PluginStart<undefined>,
	const Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
	const Siblings extends ReadonlyArray<LiftedSiblingKey> = readonly [],
>(
	spec: PluginSpecBase<Id, undefined, Start, Caps, Siblings> & {
		readonly dependsOn?: undefined;
	},
): Plugin<Id, StartValue<Start>, readonly [], Caps, Siblings>;
export function definePlugin(
	spec: PluginSpecBase<
		string,
		DependencyInput | undefined,
		PluginStart<DependencyInput | undefined>,
		ReadonlyArray<CapabilityDecl>,
		ReadonlyArray<LiftedSiblingKey>
	> & {
		readonly dependsOn?: DependencyInput;
	},
): AnyPlugin {
	const dependsOn = dependencyList(spec.dependsOn);
	const consumes = uniqueResourceRefs(dependsOn).map(tagForResource);
	const provides = defineTag<string, unknown>(spec.id, spec.id);
	const capabilitiesField = spec.capabilities;
	const capabilities =
		typeof capabilitiesField === 'function'
			? ((
					value: unknown,
					runtime: import('../substrate/plugin.ts').AcquireContext,
				) => capabilitiesField({ value, runtime }))
			: capabilitiesField;

	return {
		[MEMBER_BRAND]: true,
		[resourceBrand]: true,
		[pluginBrand]: true,
		id: spec.id,
		provides,
		consumes,
		dependsOn,
		kind: spec.kind,
		...(spec.rebootCost === undefined ? {} : { rebootCost: spec.rebootCost }),
		...(spec.watch === undefined ? {} : { watch: spec.watch }),
		acquire: (ctx) =>
			spec.start(
				{},
				resolveDependencyValues(spec.dependsOn, (resourceRef) =>
					ctx.get(tagForResource(resourceRef as AnyResourceRef) as never),
				),
			) as Effect.Effect<unknown, unknown, unknown>,
		...(capabilities === undefined ? {} : { capabilities }),
		...(spec.liftedSiblings === undefined ? {} : { liftedSiblings: spec.liftedSiblings }),
		...(spec.displayHint === undefined ? {} : { displayHint: spec.displayHint }),
		...(spec.errorContributions === undefined
			? {}
			: { errorContributions: spec.errorContributions }),
	} as AnyPlugin;
}

/**
 * Authoring helper. Accepts the plugin's tag, consumed tags,
 * acquire procedure, and capability tuple, and returns a branded
 * `StackMember` with all four generics narrowed (provides, consumes,
 * caps, lifted siblings).
 */
export function defineNodePlugin<
	Provides extends AnyTag,
	Consumes extends ReadonlyArray<AnyTag>,
	Caps extends ReadonlyArray<CapabilityDecl> = readonly [],
	Siblings extends ReadonlyArray<LiftedSiblingKey> = readonly [],
>(
	spec: Omit<StackMember<Provides, Consumes, Caps, Siblings>, typeof MEMBER_BRAND>,
): StackMember<Provides, Consumes, Caps, Siblings> {
	return {
		...spec,
		[MEMBER_BRAND]: true,
	} as StackMember<Provides, Consumes, Caps, Siblings>;
}
