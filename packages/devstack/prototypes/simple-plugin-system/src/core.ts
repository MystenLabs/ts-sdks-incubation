import { Effect } from 'effect';

const resourceValue: unique symbol = Symbol('devstack.prototype.adapter.resourceValue');
const resourceBrand: unique symbol = Symbol('devstack.prototype.adapter.resource');
const pluginBrand: unique symbol = Symbol('devstack.prototype.adapter.plugin');

export interface ResourceRef<Id extends string, Value = unknown> {
	readonly id: Id;
	readonly [resourceBrand]: true;
	readonly [resourceValue]?: () => Value;
}

export type AnyResourceRef = ResourceRef<string, any>;
export type IdOf<R extends AnyResourceRef> = R['id'];
export type ValueOf<R extends AnyResourceRef> =
	R extends ResourceRef<string, infer Value> ? Value : never;

export const defineId = <const Id extends string>(id: Id): Id => id;

export const resource = <const Id extends string, Value = unknown>(id: Id): ResourceRef<Id, Value> =>
	({
		id,
		[resourceBrand]: true,
	}) as ResourceRef<Id, Value>;

export const isResourceRef = (value: unknown): value is AnyResourceRef =>
	typeof value === 'object' &&
	value !== null &&
	(value as { readonly [resourceBrand]?: true })[resourceBrand] === true;

export interface CodegenWriter {
	readonly writeTypeScript: (sourceText: string) => Effect.Effect<void>;
}

export interface CodegenablePayload {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly sensitive?: boolean;
	readonly emit: (writer: CodegenWriter) => Effect.Effect<void>;
}

export type CodegenableDecl = CapabilityDecl<'codegenable'>;

export interface ContainerLabelTuple {
	readonly app: string;
	readonly stack: string;
	readonly plugin: string;
	readonly role: string;
}

export interface SnapshotablePayload {
	readonly subtrees: ReadonlyArray<string>;
	readonly managedContainers?: ReadonlyArray<ContainerLabelTuple>;
	readonly quiesce?: Effect.Effect<void, never, unknown>;
	readonly preRestore?: Effect.Effect<unknown, never>;
	readonly postRestore?: Effect.Effect<void, never>;
	readonly missingTolerance: 'fatal' | 'fine';
	readonly secretMaterial?: boolean;
}

export interface DispatchId {
	readonly groupKey: string;
	readonly role: string;
}

export type SnapshotableDecl = CapabilityDecl<'snapshotable'>;

export interface DevstackRoutableUpstreamRegistry {
	readonly container: { readonly containerName: string; readonly containerPort: number };
	readonly 'host-loopback': { readonly port: number };
}

export type RoutableUpstreamKind = keyof DevstackRoutableUpstreamRegistry & string;

export type RoutableUpstream<Kind extends string = RoutableUpstreamKind> = string extends Kind
	? {
			readonly [K in RoutableUpstreamKind]: Readonly<
				{ readonly type: K } & DevstackRoutableUpstreamRegistry[K]
			>;
		}[RoutableUpstreamKind]
	: Kind extends RoutableUpstreamKind
		? Readonly<{ readonly type: Kind } & DevstackRoutableUpstreamRegistry[Kind]>
		: Readonly<{ readonly type: Kind } & object>;

interface RoutableBase {
	readonly endpointName: string;
	readonly dispatchId: DispatchId;
	readonly upstream: RoutableUpstream;
}

export interface RoutableHttpPayload extends RoutableBase {
	readonly wireProtocol?: 'http' | 'h2c';
	readonly cors: boolean;
}

export interface RoutableTcpPayload extends RoutableBase {
	readonly wireProtocol: 'tcp';
}

export type RoutablePayload = RoutableHttpPayload | RoutableTcpPayload;
export type RoutableDecl = CapabilityDecl<'routable'>;

export interface StrategyContributorPayload<Key extends string = string, Strategy = unknown> {
	readonly capabilityKey: Key;
	readonly strategy: Strategy;
	readonly autoMounted: boolean;
	readonly priority?: number;
}

export type StrategyContributorDecl<Key extends string = string, Strategy = unknown> =
	CapabilityDecl<'strategy-contributor'> & Readonly<StrategyContributorPayload<Key, Strategy>>;

export interface LivenessClassifierPayload {
	readonly classifierName: string;
}

export type LivenessClassifierDecl = CapabilityDecl<'liveness-classifier'>;

export interface DevstackCapabilityRegistry {
	readonly codegenable: CodegenablePayload;
	readonly snapshotable: SnapshotablePayload;
	readonly routable: RoutablePayload;
	readonly 'strategy-contributor': StrategyContributorPayload<string, unknown>;
	readonly 'liveness-classifier': LivenessClassifierPayload;
}

export type CapabilityKind = keyof DevstackCapabilityRegistry & string;

type CapabilityPayload = object & { readonly kind?: never };

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

export type CapabilityList = readonly CapabilityDecl[];

export interface CapabilityRouterSink {
	readonly kind: string;
	readonly route: (
		decl: CapabilityDecl,
		runtime: RuntimeContext,
	) => Effect.Effect<void, unknown, unknown>;
}

export interface CapabilitySink<
	Kind extends string = string,
	Decl extends CapabilityDecl = CapabilityDecl,
> extends CapabilityRouterSink {
	readonly kind: Kind;
	readonly handle: (decl: Decl, runtime: RuntimeContext) => Effect.Effect<void, unknown, unknown>;
}

export interface CapabilityRoutingReport {
	readonly handled: ReadonlyArray<CapabilityDecl>;
	readonly unhandled: ReadonlyArray<CapabilityDecl>;
}

type CapabilityPayloadFor<Kind extends string> = Kind extends CapabilityKind
	? DevstackCapabilityRegistry[Kind] & { readonly kind?: never }
	: CapabilityPayload;

type ExactCapabilityPayload<Kind extends string, Data extends object> = Kind extends CapabilityKind
	? Record<Exclude<keyof Data, keyof CapabilityPayloadFor<Kind>>, never>
	: unknown;

export const capability = <const Kind extends string, const Data extends CapabilityPayloadFor<Kind>>(
	kind: Kind,
	data: Data & ExactCapabilityPayload<Kind, Data>,
): CapabilityDecl<Kind> & Readonly<Data> =>
	({
	...data,
	kind,
	}) as CapabilityDecl<Kind> & Readonly<Data>;

export const defineCapability =
	<const Kind extends string>(kind: Kind) =>
	<const Data extends CapabilityPayloadFor<Kind>>(
		data: Data & ExactCapabilityPayload<Kind, Data>,
	) =>
		capability<Kind, Data>(kind, data);

export const capabilitySink = <
	const Kind extends string,
	Decl extends CapabilityDecl<Kind> = CapabilityDecl<Kind>,
>(
	kind: Kind,
	handle: (decl: Decl, runtime: RuntimeContext) => Effect.Effect<void, unknown, unknown>,
): CapabilitySink<Kind, Decl> => ({
	kind,
	handle,
	route: (decl, runtime) => handle(decl as Decl, runtime),
});

export const routeCapabilities = (
	capabilities: CapabilityList,
	sinks: ReadonlyArray<CapabilityRouterSink>,
	runtime: RuntimeContext,
): Effect.Effect<CapabilityRoutingReport, unknown, unknown> =>
	Effect.gen(function* () {
		const sinkByKind = new Map(sinks.map((sink) => [sink.kind, sink]));
		const handled: CapabilityDecl[] = [];
		const unhandled: CapabilityDecl[] = [];

		for (const decl of capabilities) {
			const sink = sinkByKind.get(decl.kind);
			if (sink === undefined) {
				unhandled.push(decl);
				continue;
			}

			yield* sink.route(decl, runtime);
			handled.push(decl);
		}

		return { handled, unhandled } satisfies CapabilityRoutingReport;
	});

export const codegenable = (options: {
	readonly emitterName: string;
	readonly outputPath: string;
	readonly sensitive?: boolean;
	readonly emit: (writer: CodegenWriter) => Effect.Effect<void>;
}): CodegenableDecl => capability('codegenable', options);

export const snapshotable = (options: SnapshotablePayload): SnapshotableDecl =>
	capability('snapshotable', options);

export type RoutableInput = RoutablePayload;

export const routable = (decl: RoutableInput): RoutableDecl =>
	capability('routable', decl);

export const strategyContributor = <const Key extends string, Strategy>(options: {
	readonly capabilityKey: Key;
	readonly strategy: Strategy;
	readonly autoMounted: boolean;
	readonly priority?: number;
}): StrategyContributorDecl<Key, Strategy> =>
	capability('strategy-contributor', options);

export type PluginKind =
	keyof DevstackPluginKindRegistry & string;

export interface DevstackPluginKindRegistry {
	readonly 'leaf-long-running': {};
	readonly 'leaf-one-shot': {};
	readonly group: {};
	readonly 'hidden-leaf': {};
	readonly renderer: {};
}

export type RebootCost = 'cheap' | 'moderate' | 'heavy';

export interface WatchDecl {
	readonly paths: ReadonlyArray<string>;
	readonly cascade?: boolean;
}

export interface PluginErrorContribution {
	readonly _tag: 'PluginErrorContribution';
	readonly errorTags: ReadonlyArray<string>;
	readonly formatter?: (
		value: { readonly _tag: string } & Readonly<Record<string, unknown>>,
		recurse: (inner: unknown) => string,
	) => string | null;
}

export interface RuntimeContext {
	readonly identity: {
		readonly app: string;
		readonly stack: string;
	};
	readonly chain: string;
	readonly runtimeRoot: string;
}

export interface StartContext {}

interface AdapterStartContext<Needs extends readonly AnyResourceRef[]> extends StartContext {
	readonly get: <R extends Needs[number]>(resource: R) => ValueOf<R>;
}

export interface CapabilityContext<Value> {
	readonly value: Value;
	readonly runtime: RuntimeContext;
}

export type CapabilitySource<
	Value,
	Caps extends CapabilityList,
> = Caps | ((ctx: CapabilityContext<Value>) => Caps);

export interface DevstackLiftedSiblingScopeRegistry {
	readonly 'per-app': {};
	readonly 'per-stack': {};
	readonly 'per-process': {};
}

export type LiftedSiblingScope = keyof DevstackLiftedSiblingScopeRegistry & string;

export interface LiftedSiblingKey<
	Plugin extends string = string,
	Kind extends string = string,
	Scope extends LiftedSiblingScope = LiftedSiblingScope,
	Hash extends string = string,
> {
	readonly plugin: Plugin;
	readonly kind: Kind;
	readonly scope: Scope;
	readonly inputHash: Hash;
}

export const liftedSibling = <
	const Plugin extends string,
	const Kind extends string,
	const Scope extends LiftedSiblingScope,
	const Hash extends string,
>(options: {
	readonly plugin: Plugin;
	readonly kind: Kind;
	readonly scope: Scope;
	readonly inputHash: Hash;
}): LiftedSiblingKey<Plugin, Kind, Scope, Hash> => options;

declare const witnessBrand: unique symbol;

export interface Witness<Name extends string> {
	readonly [witnessBrand]: Name;
}

export interface RequiresWitness<Name extends string> {
	readonly _requires?: () => Witness<Name>;
}

export interface ProvidesWitness<Name extends string> {
	readonly _provides?: () => Witness<Name>;
}

export type WitnessRequiredBy<Value> = Value extends {
	readonly _requires?: () => Witness<infer Name>;
}
	? Name
	: never;

export type WitnessProvidedBy<Value> = Value extends {
	readonly _provides?: () => Witness<infer Name>;
}
	? Name
	: never;

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

export type ResolvedDependencyList<Dependencies extends readonly AnyResourceRef[]> = {
	readonly [K in keyof Dependencies]: Dependencies[K] extends AnyResourceRef
		? ValueOf<Dependencies[K]>
		: never;
};

export type ResolvedDependencyObject<Dependencies extends Readonly<Record<string, AnyResourceRef>>> = {
	readonly [K in keyof Dependencies]: Dependencies[K] extends AnyResourceRef
		? ValueOf<Dependencies[K]>
		: never;
};

export type ResolvedDependencies<Input> = [Input] extends [undefined]
	? undefined
	: [Input] extends [readonly AnyResourceRef[]]
		? ResolvedDependencyList<Input>
		: [Input] extends [AnyResourceRef]
			? ValueOf<Input>
			: [Input] extends [Readonly<Record<string, AnyResourceRef>>]
				? ResolvedDependencyObject<Input>
				: never;

type PluginStart<DependsOn extends DependencyInput | undefined> = (
	ctx: StartContext,
	deps: ResolvedDependencies<DependsOn>,
) => Effect.Effect<any, unknown, unknown>;

type StartValue<Start> =
	Start extends (...args: any) => Effect.Effect<infer Value, unknown, unknown> ? Value : never;

interface PluginSpecBase<
	Id extends string,
	DependsOn extends DependencyInput | undefined,
	Start extends PluginStart<DependsOn>,
	Caps extends CapabilityList,
	Siblings extends readonly LiftedSiblingKey[],
> {
	readonly id: Id;
	readonly kind: PluginKind;
	readonly rebootCost?: RebootCost;
	readonly watch?: WatchDecl;
	readonly start: Start;
	readonly capabilities?: CapabilitySource<StartValue<Start>, Caps>;
	readonly liftedSiblings?: Siblings;
	readonly displayHint?: unknown;
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
}

export type PluginSpec<
	Id extends string,
	DependsOn extends DependencyInput | undefined,
	Start extends PluginStart<DependsOn>,
	Caps extends CapabilityList,
	Siblings extends readonly LiftedSiblingKey[],
> = PluginSpecBase<Id, DependsOn, Start, Caps, Siblings> & {
	readonly dependsOn?: DependsOn;
};

export interface Plugin<
	Id extends string,
	Value,
	Needs extends readonly AnyResourceRef[],
	Caps extends CapabilityList,
	Siblings extends readonly LiftedSiblingKey[] = readonly LiftedSiblingKey[],
> extends ResourceRef<Id, Value> {
	readonly [pluginBrand]: true;
	readonly dependsOn: Needs;
	readonly kind: PluginKind;
	readonly rebootCost?: RebootCost;
	readonly watch?: WatchDecl;
	readonly start: (
		ctx: AdapterStartContext<Needs>,
	) => Effect.Effect<Value, unknown, unknown>;
	readonly capabilities?: CapabilitySource<Value, Caps>;
	readonly liftedSiblings?: Siblings;
	readonly displayHint?: unknown;
	readonly errorContributions?: ReadonlyArray<PluginErrorContribution>;
}

export type AnyPlugin = Plugin<
	string,
	any,
	readonly AnyResourceRef[],
	CapabilityList,
	readonly LiftedSiblingKey[]
>;

type PluginDependencies<P extends AnyPlugin> =
	P['dependsOn'][number] extends infer Dependency
		? Dependency extends AnyPlugin
			? Dependency
			: never
		: never;

type ReachablePlugin<
	P extends AnyPlugin,
	Seen extends string = never,
> = P['id'] extends Seen
	? never
	: P | ReachablePlugin<PluginDependencies<P>, Seen | P['id']>;

export type DependencyClosure<Members extends readonly AnyPlugin[]> = ReadonlyArray<
	Members[number] extends infer Member
		? Member extends AnyPlugin
			? ReachablePlugin<Member>
			: never
		: never
>;

export const isPlugin = (value: unknown): value is AnyPlugin =>
	typeof value === 'object' &&
	value !== null &&
	(value as { readonly [pluginBrand]?: true })[pluginBrand] === true;

export const expandPluginDependencies = (
	members: ReadonlyArray<AnyPlugin>,
): ReadonlyArray<AnyPlugin> => {
	const expanded: AnyPlugin[] = [];
	const seen = new Map<string, AnyPlugin>();
	const visiting = new Set<string>();

	const visit = (member: AnyPlugin) => {
		const id = member.id;
		const previous = seen.get(id);
		if (previous === member) {
			return;
		}
		if (previous !== undefined) {
			throw new Error(`Duplicate devstack provider for ${id}`);
		}
		if (visiting.has(id)) {
			throw new Error(`Circular devstack dependency through ${id}`);
		}

		visiting.add(id);
		for (const dependency of member.dependsOn) {
			if (isPlugin(dependency)) {
				visit(dependency);
			}
		}
		visiting.delete(id);
		seen.set(id, member);
		expanded.push(member);
	};

	for (const member of members) {
		visit(member);
	}

	return expanded;
};

export function definePlugin<
	const Id extends string,
	const DependsOn extends DependencyInput,
	const Start extends PluginStart<DependsOn> = PluginStart<DependsOn>,
	const Caps extends CapabilityList = CapabilityList,
	const Siblings extends readonly LiftedSiblingKey[] = readonly [],
>(
	spec: PluginSpecBase<Id, DependsOn, Start, Caps, Siblings> & { readonly dependsOn: DependsOn },
): Plugin<Id, StartValue<Start>, DependencyList<DependsOn>, Caps, Siblings>;
export function definePlugin<
	const Id extends string,
	const Start extends PluginStart<undefined> = PluginStart<undefined>,
	const Caps extends CapabilityList = CapabilityList,
	const Siblings extends readonly LiftedSiblingKey[] = readonly [],
>(
	spec: PluginSpecBase<Id, undefined, Start, Caps, Siblings> & {
		readonly dependsOn?: undefined;
	},
): Plugin<Id, StartValue<Start>, readonly [], Caps, Siblings>;
export function definePlugin(
	spec: PluginSpecBase<string, any, PluginStart<any>, CapabilityList, readonly LiftedSiblingKey[]> & {
		readonly dependsOn?: DependencyInput;
	},
): AnyPlugin {
	const dependsOn = dependencyList(spec.dependsOn);

	return {
		[resourceBrand]: true,
		[pluginBrand]: true,
		id: spec.id,
		dependsOn,
		kind: spec.kind,
		...(spec.rebootCost === undefined ? {} : { rebootCost: spec.rebootCost }),
		...(spec.watch === undefined ? {} : { watch: spec.watch }),
		start: (ctx) =>
			spec.start(
				ctx,
				resolveDependencyValues(spec.dependsOn, (resourceRef) => ctx.get(resourceRef as never)),
			) as Effect.Effect<any, unknown, unknown>,
		...(spec.capabilities === undefined ? {} : { capabilities: spec.capabilities }),
		...(spec.liftedSiblings === undefined ? {} : { liftedSiblings: spec.liftedSiblings }),
		...(spec.displayHint === undefined ? {} : { displayHint: spec.displayHint }),
		...(spec.errorContributions === undefined
			? {}
			: { errorContributions: spec.errorContributions }),
	} as AnyPlugin;
}

export const dependencyList = <Input extends DependencyInput | undefined>(
	dependsOn: Input,
): DependencyList<Input> => {
	if (dependsOn === undefined) {
		return [] as unknown as DependencyList<Input>;
	}
	if (isDependencyArray(dependsOn)) {
		return dependsOn as DependencyList<Input>;
	}
	if (isResourceRef(dependsOn)) {
		return [dependsOn] as unknown as DependencyList<Input>;
	}
	return Object.values(dependsOn) as unknown as DependencyList<Input>;
};

const isDependencyArray = (dependsOn: DependencyInput): dependsOn is readonly AnyResourceRef[] =>
	Array.isArray(dependsOn);

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

export type ProvidedIds<Members extends readonly AnyPlugin[]> = Members[number]['id'];

export type NeededIds<Members extends readonly AnyPlugin[]> =
	Members[number]['dependsOn'][number] extends infer Need
		? Need extends AnyResourceRef
			? Need['id']
			: never
		: never;

export type MissingProviders<Members extends readonly AnyPlugin[]> = Exclude<
	NeededIds<Members>,
	ProvidedIds<Members>
>;

export type DuplicateIds<
	Members extends readonly AnyPlugin[],
	Seen extends string = never,
> = Members extends readonly [infer Head, ...infer Tail]
		? Head extends AnyPlugin
			? Tail extends readonly AnyPlugin[]
				? Head['id'] extends Seen
					? Head['id'] | DuplicateIds<Tail, Seen>
					: DuplicateIds<Tail, Seen | Head['id']>
			: never
		: never
	: never;

type SiblingKeysOf<Members extends readonly AnyPlugin[]> =
	Members[number] extends infer Member
		? Member extends { readonly liftedSiblings?: infer Siblings }
			? Siblings extends readonly LiftedSiblingKey[]
				? Siblings[number]
				: never
			: never
		: never;

type SiblingGroupKey<Key> =
	Key extends LiftedSiblingKey<infer Plugin, infer Kind, infer Scope, string>
		? `${Plugin}|${Kind}|${Scope}`
		: never;

type SiblingHashOf<Key> =
	Key extends LiftedSiblingKey<string, string, LiftedSiblingScope, infer Hash> ? Hash : never;

type SiblingHashesForGroup<Group extends string, Siblings> =
	Siblings extends infer Sibling
		? Sibling extends LiftedSiblingKey<string, string, LiftedSiblingScope, string>
			? SiblingGroupKey<Sibling> extends Group
				? SiblingHashOf<Sibling>
				: never
			: never
		: never;

type IsUnion<Value, Whole = Value> = [Value] extends [never]
	? false
	: Value extends unknown
		? [Whole] extends [Value]
			? false
			: true
		: false;

type IsUniformSiblingHash<Group extends string, Siblings> = [
	IsUnion<SiblingHashesForGroup<Group, Siblings>>,
] extends [true]
	? false
	: true;

type ConflictingSiblingGroupsFor<Sibling, AllSiblings> =
	Sibling extends LiftedSiblingKey<string, string, LiftedSiblingScope, string>
		? IsUniformSiblingHash<SiblingGroupKey<Sibling>, AllSiblings> extends false
			? SiblingGroupKey<Sibling>
			: never
		: never;

export type ConflictingSiblingGroups<Members extends readonly AnyPlugin[]> =
	ConflictingSiblingGroupsFor<SiblingKeysOf<Members>, SiblingKeysOf<Members>>;

export type RequiredWitnesses<Members extends readonly AnyPlugin[]> =
	Members[number] extends infer Member
		? Member extends AnyPlugin
			? WitnessRequiredBy<ValueOf<Member>>
			: never
		: never;

export type ProvidedWitnesses<Members extends readonly AnyPlugin[]> =
	Members[number] extends infer Member
		? Member extends AnyPlugin
			? WitnessProvidedBy<ValueOf<Member>>
			: never
		: never;

export type UnsatisfiedWitnesses<Members extends readonly AnyPlugin[]> = Exclude<
	RequiredWitnesses<Members>,
	ProvidedWitnesses<Members>
>;

export interface MissingProviderError<Ids extends string> {
	readonly missingProviders: Ids;
}

export interface DuplicateProviderError<Ids extends string> {
	readonly duplicateProviders: Ids;
}

export interface SiblingHashConflictError<Groups extends string> {
	readonly siblingHashConflicts: Groups;
}

export interface UnsatisfiedWitnessError<Names extends string> {
	readonly unsatisfiedWitnesses: Names;
}

export type ValidateStack<Members extends readonly AnyPlugin[]> =
	[DuplicateIds<Members>] extends [never]
		? [MissingProviders<Members>] extends [never]
			? [ConflictingSiblingGroups<Members>] extends [never]
				? [UnsatisfiedWitnesses<Members>] extends [never]
					? unknown
					: UnsatisfiedWitnessError<UnsatisfiedWitnesses<Members>>
				: SiblingHashConflictError<ConflictingSiblingGroups<Members>>
			: MissingProviderError<MissingProviders<Members>>
		: DuplicateProviderError<DuplicateIds<Members>>;

export interface DevstackOptions {
	readonly stackName?: string;
	readonly network?: NetworkConfig;
	readonly codegen?: {
		readonly outputDir?: string;
	};
}

export interface DevstackNetworkModeRegistry {
	readonly local: { readonly rpcUrl?: string };
	readonly live: { readonly rpcUrl?: string };
	readonly fork: { readonly rpcUrl?: string; readonly checkpoint?: string };
}

export type NetworkMode = keyof DevstackNetworkModeRegistry & string;

export type NetworkConfig<Mode extends NetworkMode = NetworkMode> = Mode extends NetworkMode
	? Readonly<{ readonly mode: Mode; readonly name: string } & DevstackNetworkModeRegistry[Mode]>
	: never;

type ExtraNetworkKeys<Network, Mode extends NetworkMode> = Exclude<
	keyof Network,
	keyof NetworkConfig<Mode>
>;

type ExactNetworkConfig<Network extends { readonly mode: NetworkMode }> =
	Network['mode'] extends infer Mode
		? Mode extends NetworkMode
			? NetworkConfig<Mode> & Record<ExtraNetworkKeys<Network, Mode>, never>
			: never
		: never;

export const defineNetwork = <
	const Network extends { readonly mode: NetworkMode; readonly name: string },
>(
	network: Network & ExactNetworkConfig<Network>,
): NetworkConfig<Network['mode']> => network;

export type FactoriesFor<
	Factories extends Partial<Record<NetworkMode, unknown>>,
	Mode extends NetworkMode,
> = Mode extends keyof Factories ? Factories[Mode] : never;

export interface ModeNamespace<Factories extends Partial<Record<NetworkMode, unknown>>> {
	readonly for: <Network extends NetworkConfig>(
		network: Network,
	) => FactoriesFor<Factories, Network['mode']>;
}

export const defineModeNamespace = <
	const Factories extends Partial<Record<NetworkMode, unknown>>,
>(
	factories: Factories,
): ModeNamespace<Factories> => ({
	for: <Network extends NetworkConfig>(network: Network) =>
		factories[network.mode as keyof Factories] as FactoriesFor<Factories, Network['mode']>,
});

export interface DevstackStack<Members extends readonly AnyPlugin[]> {
	readonly members: Members;
	readonly options: DevstackOptions;
}

export const createDevstackStack = <const Members extends readonly AnyPlugin[]>(
	members: Members & ValidateStack<Members>,
	options: DevstackOptions = {},
): DevstackStack<Members> => ({
	members,
	options,
});
