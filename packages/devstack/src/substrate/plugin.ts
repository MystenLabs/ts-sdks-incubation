// Resource-native plugin contract.
//
// Public plugin authors use `definePlugin({ id, dependsOn, start })`.
// The substrate now consumes that same shape directly: resource ids
// drive scheduling, resolved dependency values are constructed by the
// supervisor, and plugin bodies run through `start(...)`.

import type { Effect } from 'effect';

import type { CapabilityDecl } from '../contracts/capability-decl.ts';
import type { ChainId, PluginKey } from './brand.ts';
import type { Identity } from './identity.ts';
import type { PluginRole } from './lifecycle.ts';
import type { PluginCtx } from './plugin-ctx.ts';
import type { RowSection } from './projection.ts';

const resourceBrand: unique symbol = Symbol.for('devstack.resource') as never;
const pluginBrand: unique symbol = Symbol.for('devstack.plugin') as never;
const resourceValue: unique symbol = Symbol.for('devstack.resource.value') as never;
const dependencyInputBrand: unique symbol = Symbol.for('devstack.plugin.dependency-input') as never;

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

export type ResolvedDependencyList<Dependencies extends readonly AnyResourceRef[]> = readonly [
	...{
		readonly [K in keyof Dependencies]: Dependencies[K] extends AnyResourceRef
			? ResourceValueOf<Dependencies[K]>
			: never;
	},
];

export type ResolvedDependencyObject<
	Dependencies extends Readonly<Record<string, AnyResourceRef>>,
> = {
	readonly [K in keyof Dependencies]: Dependencies[K] extends AnyResourceRef
		? ResourceValueOf<Dependencies[K]>
		: never;
};

export type ResolvedDependencies<Input> = Input extends undefined
	? undefined
	: Input extends readonly AnyResourceRef[]
		? ResolvedDependencyList<Input>
		: Input extends AnyResourceRef
			? ResourceValueOf<Input>
			: Input extends Readonly<Record<string, AnyResourceRef>>
				? ResolvedDependencyObject<Input>
				: never;

// The erased start shape. `(...args: any[])` absorbs the additive
// optional `ctx` 2nd argument the supervisor passes (`start(deps, ctx)`)
// without forcing every authoring-side `PluginStart` to re-infer around
// it. `StartValue` recovers the Value from the success channel through
// this same loose match.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPluginStart = (...args: any[]) => Effect.Effect<unknown, unknown, unknown>;

// Stage B (P0): the ADDITIVE optional `ctx` argument lands on the
// runtime-facing `Plugin.start` type + `AnyPluginStart` (below), which
// is what the supervisor calls (`start(deps, ctx)`), and on the public
// `start` overloads via the loose `AnyPluginStart` bound. It is
// DELIBERATELY absent from this `PluginStart<Deps>` inference helper.
//
// Why: `PluginStart<Deps>` is the contextual type the `const Start`
// generic is inferred from when a plugin authors `start: (deps) => …`.
// Adding a 2nd positional/optional/rest param here degrades `deps`
// inference to `any` for the plugins whose `dependsOn` is a runtime-
// built (non-literal) array — `account` / `action` / `wallet` /
// `deepbook` — because `Start` is then inferred from a 1-arg arrow
// against a 2-arg target and the `deps` contextual type collapses. The
// helper stays single-arg so baseline inference is byte-identical; a
// plugin that opts into `ctx` reads it off the additive slot exposed on
// the materialized `Plugin.start`. P2 widens authoring to a 2-arg body
// (and P5 makes ctx required) — out of scope for the foundation.
// The DEFAULT contextual shape `const Start` resolves to when a plugin
// authors `start: (deps) => …` and lets TypeScript NOT infer `Start`
// from the arrow. Kept SINGLE-arg so the deps-bearing plugins whose
// `dependsOn` is a runtime-built (non-literal) array
// (account/action/wallet/deepbook/seal/walrus) keep contextually typing
// `deps` via this default — adding the ctx slot here regresses that
// inference to `any` (the default no longer arity-matches the 1-arg
// arrow, so `Start` is inferred from the arrow and `Deps` never reaches
// `deps`). The ADDITIVE optional `ctx` 2nd argument is admitted by
// loosening the `definePlugin` overloads' `Start` CONSTRAINT to
// `AnyPluginStart` (a `(...args: any[])` super-shape) while keeping THIS
// as the default: a 2-arg `(deps, ctx) =>` body satisfies the loose
// constraint and types `deps`/`ctx` from its own annotations, and a
// 1-arg body falls back to this default. The runtime-facing
// `Plugin.start` (below) carries `ctx?` directly — that is what the
// supervisor calls.
type PluginStart<Deps> = [Deps] extends [undefined]
	? () => Effect.Effect<unknown, unknown, unknown>
	: (deps: Deps) => Effect.Effect<unknown, unknown, unknown>;

type StartValue<Start> = Start extends (
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	...args: any[]
) => Effect.Effect<infer Value, unknown, unknown>
	? Value
	: never;

export interface PluginErrorContribution {
	readonly _tag: 'PluginErrorContribution';
	readonly errorTags: ReadonlyArray<string>;
	readonly formatter?: (
		value: { readonly _tag: string } & Readonly<Record<string, unknown>>,
		recurse: (inner: unknown) => string,
	) => string | null;
}

export interface WatchDecl {
	readonly paths: ReadonlyArray<string>;
	readonly cascade?: boolean;
}

export interface AcquireContext {
	readonly identity: Identity;
	readonly chain: ChainId;
	readonly runtimeRoot: string;
}

export type CapabilitiesFactory<Caps extends ReadonlyArray<CapabilityDecl>, Resolved> = (
	resolved: Resolved,
	ctx: AcquireContext,
) => Caps;

export type CapabilitySource<Value, Caps extends ReadonlyArray<CapabilityDecl>> =
	| Caps
	| ((ctx: { readonly value: Value; readonly runtime: AcquireContext }) => Caps);

interface PluginSpecBase<
	Id extends string,
	Start extends AnyPluginStart,
	Caps extends ReadonlyArray<CapabilityDecl>,
> {
	readonly id: Id;
	readonly role: PluginRole;
	readonly pluginKey?: PluginKey | string;
	readonly watch?: WatchDecl;
	readonly start: Start;
	readonly capabilities?: CapabilitySource<StartValue<Start>, Caps>;
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
	/** Dashboard section bucket the plugin's rows belong to. Required so
	 *  the renderer never has to pattern-match on plugin name substrings
	 *  to compute it. The supervisor stamps this onto every row at
	 *  acquire-time. */
	readonly section: RowSection;
	/** Optional override for rows that own a routed endpoint. When set
	 *  and the row carries an endpoint, the renderer groups it under
	 *  `endpointSection` instead of `section`. Use sparingly — the
	 *  default is for the plugin's normal `section` to apply uniformly. */
	readonly endpointSection?: RowSection;
	/** When `true`, a live snapshot-restore re-acquire leaves this plugin
	 *  running instead of draining it. Reserved for operator-transport
	 *  plugins that carry no restorable chain state and would tear down the
	 *  very connection a restore is answering on if drained. Substrate's
	 *  restore planner filters on this flag with NO knowledge of which
	 *  plugins set it. Full restart (`stack.restart` / CLI) drains
	 *  everything regardless. */
	readonly keepAliveOnRestore?: true;
}

export type PluginSpec<
	Id extends string,
	DependsOn extends DependencyInput | undefined,
	Start extends AnyPluginStart,
	Caps extends ReadonlyArray<CapabilityDecl>,
> = PluginSpecBase<Id, Start, Caps> & {
	readonly dependsOn?: DependsOn;
};

export interface Plugin<
	Id extends string,
	Value,
	Needs extends readonly AnyResourceRef[],
	Caps extends ReadonlyArray<CapabilityDecl>,
> extends ResourceRef<Id, Value> {
	readonly [pluginBrand]: true;
	readonly [dependencyInputBrand]: DependencyInput | undefined;
	readonly dependsOn: Needs;
	readonly role: PluginRole;
	readonly pluginKey?: PluginKey | string;
	readonly watch?: WatchDecl;
	readonly start: (
		deps: ResolvedDependencies<DependencyInput | undefined>,
		ctx?: PluginCtx,
	) => Effect.Effect<Value, unknown, unknown>;
	readonly capabilities?: Caps | CapabilitiesFactory<Caps, Value>;
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
	readonly section: RowSection;
	readonly endpointSection?: RowSection;
	readonly keepAliveOnRestore?: true;
}

export type AnyPlugin = Plugin<
	string,
	// Erased runtime plugin values must be `any` rather than `unknown`
	// so concrete dynamic capability factories remain assignable under
	// strict function parameter variance. Precise value types stay on
	// concrete `Plugin<Id, Value, ...>` instances.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any,
	readonly AnyResourceRef[],
	ReadonlyArray<CapabilityDecl>
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

export const uniqueResourceRefs = (refs: readonly AnyResourceRef[]): readonly AnyResourceRef[] => {
	const seen = new Set<string>();
	const unique: AnyResourceRef[] = [];
	for (const ref of refs) {
		if (seen.has(ref.id)) continue;
		seen.add(ref.id);
		unique.push(ref);
	}
	return unique;
};

export const resolveDependencyValues = <Input extends DependencyInput | undefined>(
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

export const resolvePluginDependencies = (
	plugin: AnyPlugin,
	read: (resource: AnyResourceRef) => unknown,
): ResolvedDependencies<DependencyInput | undefined> =>
	resolveDependencyValues(plugin[dependencyInputBrand], (resourceRef) =>
		read(resourceRef as AnyResourceRef),
	);

export const pluginDependencyRefs = (plugin: AnyPlugin): readonly AnyResourceRef[] =>
	dependencyList(plugin[dependencyInputBrand]) as readonly AnyResourceRef[];

// Stage B (P0): the `Start` CONSTRAINT is the loose `AnyPluginStart`
// (`(...args: any[]) => Effect`), while the DEFAULT stays the single-arg
// `PluginStart<Deps>`. A 1-arg `start: (deps) => …` body falls back to
// the default (baseline-identical `deps` inference, zero plugin edits);
// an additive 2-arg `start: (deps, ctx) => …` body satisfies the loose
// constraint and types `deps`/`ctx` from its own annotations. Tightening
// the constraint to `PluginStart` (or any 2-arg-capable shape) regresses
// `deps` to `any` for the plugins whose `dependsOn` is a runtime-built
// array — see the note on `PluginStart` above.
export function definePlugin<
	const Id extends string,
	const DependsOn extends readonly AnyResourceRef[],
	const Start extends AnyPluginStart = PluginStart<ResolvedDependencyList<DependsOn>>,
	const Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
>(
	spec: PluginSpecBase<Id, Start, Caps> & {
		readonly dependsOn: DependsOn;
	},
): Plugin<Id, StartValue<Start>, DependsOn, Caps>;
export function definePlugin<
	const Id extends string,
	const DependsOn extends Readonly<Record<string, AnyResourceRef>>,
	const Start extends AnyPluginStart = PluginStart<ResolvedDependencyObject<DependsOn>>,
	const Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
>(
	spec: PluginSpecBase<Id, Start, Caps> & {
		readonly dependsOn: DependsOn;
	},
): Plugin<Id, StartValue<Start>, DependencyList<DependsOn>, Caps>;
export function definePlugin<
	const Id extends string,
	const DependsOn extends AnyResourceRef,
	const Start extends AnyPluginStart = PluginStart<ResourceValueOf<DependsOn>>,
	const Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
>(
	spec: PluginSpecBase<Id, Start, Caps> & {
		readonly dependsOn: DependsOn;
	},
): Plugin<Id, StartValue<Start>, readonly [DependsOn], Caps>;
export function definePlugin<
	const Id extends string,
	const Start extends AnyPluginStart = PluginStart<undefined>,
	const Caps extends ReadonlyArray<CapabilityDecl> = ReadonlyArray<CapabilityDecl>,
>(
	spec: PluginSpecBase<Id, Start, Caps> & {
		readonly dependsOn?: undefined;
	},
): Plugin<Id, StartValue<Start>, readonly [], Caps>;
export function definePlugin(
	spec: PluginSpecBase<string, AnyPluginStart, ReadonlyArray<CapabilityDecl>> & {
		readonly dependsOn?: DependencyInput;
	},
): AnyPlugin {
	const dependsOn = uniqueResourceRefs(dependencyList(spec.dependsOn));
	const capabilitiesField = spec.capabilities;
	const capabilities =
		typeof capabilitiesField === 'function'
			? (value: unknown, runtime: AcquireContext) => capabilitiesField({ value, runtime })
			: capabilitiesField;

	return {
		[resourceBrand]: true,
		[pluginBrand]: true,
		[dependencyInputBrand]: spec.dependsOn,
		id: spec.id,
		dependsOn,
		role: spec.role,
		section: spec.section,
		start: spec.start as AnyPlugin['start'],
		...(spec.pluginKey === undefined ? {} : { pluginKey: spec.pluginKey }),
		...(spec.watch === undefined ? {} : { watch: spec.watch }),
		...(capabilities === undefined ? {} : { capabilities }),
		...(spec.errorContributions === undefined
			? {}
			: { errorContributions: spec.errorContributions }),
		...(spec.endpointSection === undefined ? {} : { endpointSection: spec.endpointSection }),
		...(spec.keepAliveOnRestore === undefined
			? {}
			: { keepAliveOnRestore: spec.keepAliveOnRestore }),
	} as AnyPlugin;
}

export type ProvidedIdsOf<Members> =
	Members extends ReadonlyArray<unknown>
		? Members[number] extends { readonly id: infer Id extends string }
			? Id
			: never
		: never;

export type ConsumedIdsOf<Members> =
	Members extends ReadonlyArray<unknown>
		? Members[number] extends { readonly dependsOn: infer Dependencies }
			? Dependencies extends ReadonlyArray<infer Dependency>
				? Dependency extends { readonly id: infer Id extends string }
					? Id
					: never
				: never
			: never
		: never;

export type MissingProviders<Members> = Exclude<ConsumedIdsOf<Members>, ProvidedIdsOf<Members>>;

export interface __MissingProvidersError<Missing extends string> {
	readonly __missing_providers: Missing;
}
