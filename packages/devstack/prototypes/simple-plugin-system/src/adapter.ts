import { Effect } from 'effect';

import type {
	AnyPlugin,
	AnyResourceRef,
	CapabilityContext,
	CapabilityList,
	DevstackStack,
	IdOf,
	Plugin,
	PluginErrorContribution,
	PluginKind,
	RebootCost,
	RuntimeContext,
	ValueOf,
	WatchDecl,
} from './core.ts';

export const CURRENT_MEMBER_BRAND: unique symbol = Symbol.for('devstack.member');

export interface CurrentTag<Id extends string, Value> {
	readonly key: Id;
	readonly id: Id;
	readonly _resolved?: () => Value;
}

export type AnyCurrentTag = CurrentTag<string, any>;
export type CurrentValueOf<T extends AnyCurrentTag> =
	T extends CurrentTag<string, infer Value> ? Value : never;

export const toCurrentTag = <R extends AnyResourceRef>(
	ref: R,
): CurrentTag<IdOf<R>, ValueOf<R>> =>
	({
		key: ref.id,
		id: ref.id,
	}) as CurrentTag<IdOf<R>, ValueOf<R>>;

export type CurrentTagsOf<Refs extends readonly AnyResourceRef[]> = {
	readonly [K in keyof Refs]: Refs[K] extends AnyResourceRef
		? CurrentTag<IdOf<Refs[K]>, ValueOf<Refs[K]>>
		: never;
};

export interface CurrentBuildContext<Provided extends AnyCurrentTag> {
	readonly get: <T extends Provided>(tag: T) => CurrentValueOf<T>;
}

export type CurrentCapabilitiesFactory<
	Caps extends CapabilityList,
	Resolved,
> = (resolved: Resolved, ctx: RuntimeContext) => Caps;

export interface CurrentEngineMember<
	Provides extends AnyCurrentTag = AnyCurrentTag,
	Consumes extends readonly AnyCurrentTag[] = readonly AnyCurrentTag[],
	Caps extends CapabilityList = CapabilityList,
> {
	readonly [CURRENT_MEMBER_BRAND]: true;
	readonly provides: Provides;
	readonly consumes: Consumes;
	readonly kind: PluginKind;
	readonly rebootCost?: RebootCost;
	readonly watch?: WatchDecl;
	readonly acquire: (
		ctx: CurrentBuildContext<Consumes[number]>,
	) => Effect.Effect<CurrentValueOf<Provides>, unknown, unknown>;
	readonly capabilities?: Caps | CurrentCapabilitiesFactory<Caps, CurrentValueOf<Provides>>;
	readonly liftedSiblings?: ReadonlyArray<unknown>;
	readonly displayHint?: unknown;
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
}

export interface CurrentEngineStack {
	readonly members: ReadonlyArray<CurrentEngineMember>;
}

const uniqueResourceRefs = <Refs extends readonly AnyResourceRef[]>(
	refs: Refs,
): readonly AnyResourceRef[] => {
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

type PluginStartContext<P extends AnyPlugin> = Parameters<P['start']>[0];

export const toCurrentEngineMember = <P extends AnyPlugin>(
	plugin: P,
): CurrentEngineMember<
	CurrentTag<IdOf<P>, ValueOf<P>>,
	CurrentTagsOf<P['dependsOn']>,
	P extends Plugin<string, any, readonly AnyResourceRef[], infer Caps> ? Caps : CapabilityList
> => {
	const provides = toCurrentTag(plugin);
	const consumes = uniqueResourceRefs(plugin.dependsOn).map(toCurrentTag) as CurrentTagsOf<
		P['dependsOn']
	>;
	const capabilitiesField = plugin.capabilities;
	const currentCapabilities =
		typeof capabilitiesField === 'function'
			? ((
					value: ValueOf<P>,
					runtime: RuntimeContext,
				) =>
					capabilitiesField({
						value,
						runtime,
					} as CapabilityContext<ValueOf<P>>))
			: capabilitiesField;

	return {
		[CURRENT_MEMBER_BRAND]: true,
		provides,
		consumes,
		kind: plugin.kind,
		...(plugin.rebootCost === undefined ? {} : { rebootCost: plugin.rebootCost }),
		...(plugin.watch === undefined ? {} : { watch: plugin.watch }),
		acquire: (ctx) =>
			plugin.start({
				get: (resourceRef) => ctx.get(toCurrentTag(resourceRef) as (typeof consumes)[number]),
			} as PluginStartContext<P>),
		...(currentCapabilities === undefined ? {} : { capabilities: currentCapabilities }),
		...(plugin.liftedSiblings === undefined ? {} : { liftedSiblings: plugin.liftedSiblings }),
		...(plugin.displayHint === undefined ? {} : { displayHint: plugin.displayHint }),
		...(plugin.errorContributions === undefined
			? {}
			: { errorContributions: plugin.errorContributions }),
	} as CurrentEngineMember<
		CurrentTag<IdOf<P>, ValueOf<P>>,
		CurrentTagsOf<P['dependsOn']>,
		P extends Plugin<string, any, readonly AnyResourceRef[], infer Caps> ? Caps : CapabilityList
	>;
};

export const toCurrentEngineStack = (stack: DevstackStack<readonly AnyPlugin[]>): CurrentEngineStack => ({
	members: stack.members.map(toCurrentEngineMember),
});
