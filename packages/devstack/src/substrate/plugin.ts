// Resource-native plugin contract.
//
// Public plugin authors use `definePlugin({ id, dependsOn, start })`.
// The substrate now consumes that same shape directly: resource ids
// drive scheduling, resolved dependency values are constructed by the
// supervisor, and plugin bodies run through `start(...)`.

import type { Effect } from 'effect';

import type { PluginKey } from './brand.ts';
import type { PluginRole } from './lifecycle.ts';
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

// The erased start shape. A plugin's `start` is single-arg
// (`(deps) => Effect` or `() => Effect`). The R-channel is `unknown`
// because the supervisor provides the ambient requirements (`PluginCtx`
// via the `PluginContext` service tag, plus infra) before running it —
// those requirements never surface in the public contract. `StartValue`
// recovers the Value from the success channel.
type AnyPluginStart = (deps: never) => Effect.Effect<unknown, unknown, unknown>;

// `ctx` is delivered to plugins through the `PluginContext` service tag
// (`const ctx = yield* PluginContext`), NOT as a 2nd positional `start`
// argument. That keeps `start` STRICTLY single-arg, which is what
// gives `deps` automatic contextual typing.
//
// `PluginStart<Deps>` is both the CONSTRAINT and the DEFAULT contextual
// shape `const Start` resolves to when a plugin authors `start: (deps) =>
// …` (or `start: () => …`). Keeping it single-arg is load-bearing:
//
//   - `deps` contextually types from the resolved `dependsOn` for EVERY
//     plugin, including those whose `dependsOn` is a runtime-built
//     (non-literal) array — `account` / `wallet` / `deepbook` — with no
//     per-plugin `deps:` annotation. (A `ctx` 2nd slot, optional OR
//     required, regressed `deps` to `any` for exactly those plugins,
//     which is why ctx now arrives via the requirement channel instead.)
//
// The `start` Effect's R-channel may include `PluginContext` (and infra
// services) — that is an ambient requirement the supervisor satisfies; it
// is held as `unknown` here and never propagates into
// `Plugin<Id, Value, Needs>` (`Needs` = `dependsOn` only).
type PluginStart<Deps> = [Deps] extends [undefined]
	? () => Effect.Effect<unknown, unknown, unknown>
	: (deps: Deps) => Effect.Effect<unknown, unknown, unknown>;

type StartValue<Start> = Start extends (
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	deps: any,
) => Effect.Effect<infer Value, unknown, unknown>
	? Value
	: never;

export interface WatchDecl {
	readonly paths: ReadonlyArray<string>;
	readonly cascade?: boolean;
}

interface PluginSpecBase<Id extends string, Start extends AnyPluginStart> {
	readonly id: Id;
	readonly role: PluginRole;
	readonly pluginKey?: PluginKey | string;
	readonly watch?: WatchDecl;
	readonly start: Start;
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
> = PluginSpecBase<Id, Start> & {
	readonly dependsOn?: DependsOn;
};

export interface Plugin<
	Id extends string,
	Value,
	Needs extends readonly AnyResourceRef[],
> extends ResourceRef<Id, Value> {
	readonly [pluginBrand]: true;
	readonly [dependencyInputBrand]: DependencyInput | undefined;
	readonly dependsOn: Needs;
	readonly role: PluginRole;
	readonly pluginKey?: PluginKey | string;
	readonly watch?: WatchDecl;
	readonly start: (
		deps: ResolvedDependencies<DependencyInput | undefined>,
	) => Effect.Effect<Value, unknown, unknown>;
	readonly section: RowSection;
	readonly endpointSection?: RowSection;
	readonly keepAliveOnRestore?: true;
}

export type AnyPlugin = Plugin<
	string,
	// Erased runtime plugin values must be `any` rather than `unknown`
	// so concrete plugin instances remain assignable under strict
	// function parameter variance. Precise value types stay on concrete
	// `Plugin<Id, Value, ...>` instances.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	any,
	readonly AnyResourceRef[]
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

// Both the `Start` CONSTRAINT and DEFAULT are the single-arg
// `PluginStart<Deps>`. A `start: (deps) => …` (or
// `start: () => …`) body falls back to the default and contextually
// types `deps` from the resolved `dependsOn` — no per-plugin `deps:`
// annotation, including for plugins whose `dependsOn` is a runtime-built
// array. Plugins reach `ctx` via `const ctx = yield* PluginContext`
// inside the body; that requirement rides the start Effect's R-channel
// (held as `unknown` by `PluginStart`) and never reaches the public
// `Plugin` contract.
export function definePlugin<
	const Id extends string,
	const DependsOn extends readonly AnyResourceRef[],
	const Start extends AnyPluginStart = PluginStart<ResolvedDependencyList<DependsOn>>,
>(
	spec: PluginSpecBase<Id, Start> & {
		readonly dependsOn: DependsOn;
	},
): Plugin<Id, StartValue<Start>, DependsOn>;
export function definePlugin<
	const Id extends string,
	const DependsOn extends Readonly<Record<string, AnyResourceRef>>,
	const Start extends AnyPluginStart = PluginStart<ResolvedDependencyObject<DependsOn>>,
>(
	spec: PluginSpecBase<Id, Start> & {
		readonly dependsOn: DependsOn;
	},
): Plugin<Id, StartValue<Start>, DependencyList<DependsOn>>;
export function definePlugin<
	const Id extends string,
	const DependsOn extends AnyResourceRef,
	const Start extends AnyPluginStart = PluginStart<ResourceValueOf<DependsOn>>,
>(
	spec: PluginSpecBase<Id, Start> & {
		readonly dependsOn: DependsOn;
	},
): Plugin<Id, StartValue<Start>, readonly [DependsOn]>;
export function definePlugin<
	const Id extends string,
	const Start extends AnyPluginStart = PluginStart<undefined>,
>(
	spec: PluginSpecBase<Id, Start> & {
		readonly dependsOn?: undefined;
	},
): Plugin<Id, StartValue<Start>, readonly []>;
export function definePlugin(
	spec: PluginSpecBase<string, AnyPluginStart> & {
		readonly dependsOn?: DependencyInput;
	},
): AnyPlugin {
	const dependsOn = uniqueResourceRefs(dependencyList(spec.dependsOn));

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
