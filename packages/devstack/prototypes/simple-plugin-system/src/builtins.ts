import { Effect } from 'effect';

import {
	type AnyPlugin,
	type AnyResourceRef,
	type DependencyClosure,
	type DependencyInput,
	type DevstackStack,
	type DevstackOptions,
	type DuplicateIds,
	type DuplicateProviderError,
	type NetworkConfig,
	type ResourceRef,
	type ResolvedDependencies,
	type StartContext,
	type ValidateStack,
	type ValueOf,
	codegenable,
	createDevstackStack,
	defineId,
	definePlugin,
	dependencyList,
	expandPluginDependencies,
	isResourceRef,
	isPlugin,
	resource,
	routable,
	snapshotable,
	strategyContributor,
} from './core.ts';

export interface SuiClient {
	readonly rpcUrl: string;
	readonly faucetUrl: string;
	readonly chainId: string;
}

export interface AccountValue {
	readonly name: string;
	readonly address: string;
	readonly sign: (transactionBytes: Uint8Array) => Effect.Effect<Uint8Array>;
}

export interface PackageValue {
	readonly name: string;
	readonly packageId: string;
	readonly sourcePath: string;
}

export interface WalletValue<Accounts extends readonly AnyAccountRef[] = readonly AnyAccountRef[]> {
	readonly url: string;
	readonly pairUrl: string;
	readonly accounts: {
		readonly [K in keyof Accounts]: ValueOf<Accounts[K]>;
	};
}

export interface ActionReceipt {
	readonly name: string;
	readonly digest: string;
}

export interface HostServiceValue {
	readonly url: string;
	readonly port: number;
	readonly env: Readonly<Record<string, string>>;
}

export const Sui = resource<'sui', SuiClient>('sui');

export interface SuiNetworkBindings {
	readonly rpcUrl: string;
	readonly faucetUrl: string;
	readonly chainId: string;
}

export const sui = () =>
	definePlugin({
		id: 'sui',
		kind: 'leaf-long-running',
		rebootCost: 'heavy',
		start: () =>
			Effect.succeed({
				rpcUrl: 'http://127.0.0.1:9000',
				faucetUrl: 'http://127.0.0.1:9123',
				chainId: 'localnet',
			} satisfies SuiClient),
		capabilities: ({ value }) =>
			[
				snapshotable({
					subtrees: ['runtime/sui'],
					missingTolerance: 'fine',
				}),
				codegenable({
					emitterName: 'sui-network',
					outputPath: 'sui/network.ts',
					emit: (writer) =>
						writer.writeTypeScript(
							`export const suiNetwork = ${JSON.stringify(
								{
									rpcUrl: value.rpcUrl,
									faucetUrl: value.faucetUrl,
									chainId: value.chainId,
								} satisfies SuiNetworkBindings,
								null,
								2,
							)};\n`,
						),
				}),
				strategyContributor({
					capabilityKey: `chain-probe:${value.chainId}`,
					strategy: { rpcUrl: value.rpcUrl },
					autoMounted: true,
				}),
			],
	});

export type AccountRef = ResourceRef<`account/${string}`, AccountValue>;
export type AnyAccountRef = AccountRef;

const accountId = <const Id extends string>(name: Id): `account/${Id}` =>
	defineId(`account/${name}`);

export const accountRef = <const Id extends string>(name: Id) =>
	resource<`account/${Id}`, AccountValue>(accountId(name));

export const account = <const Id extends string>(name: Id) =>
	definePlugin({
		id: accountId(name),
		dependsOn: Sui,
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		start: () =>
			Effect.succeed({
				name,
				address: `0x${name}`,
				sign: (bytes: Uint8Array) => Effect.succeed(bytes),
			} satisfies AccountValue),
		capabilities: ({ value, runtime }) =>
			[
				snapshotable({
					subtrees: [`accounts/${name}`],
					missingTolerance: 'fine',
					secretMaterial: true,
					managedContainers: [
						{
							app: runtime.identity.app,
							stack: runtime.identity.stack,
							plugin: 'account',
							role: name,
						},
					],
				}),
				codegenable({
					emitterName: accountId(name),
					outputPath: `accounts/${name}.ts`,
					emit: (writer) =>
						writer.writeTypeScript(
							`export const account = ${JSON.stringify(
								{
									name,
									address: value.address,
								},
								null,
								2,
							)};\n`,
						),
				}),
				strategyContributor({
					capabilityKey: `account:${name}`,
					strategy: { name, address: value.address },
					autoMounted: true,
				}),
			],
		errorContributions: [
			{
				_tag: 'PluginErrorContribution',
				errorTags: ['AccountAcquireFailed'],
			},
		],
	});

export type PackageRef = ResourceRef<`package:${string}`, PackageValue>;

export interface LocalPackageOptions<Publisher extends AnyAccountRef> {
	readonly sourcePath: string;
	readonly publisher: Publisher;
}

const packageId = <const Id extends string>(name: Id): `package:${Id}` =>
	defineId(`package:${name}`);

export const localPackage = <
	const Id extends string,
	const Publisher extends AnyAccountRef,
>(
	name: Id,
	options: LocalPackageOptions<Publisher>,
) =>
	definePlugin({
		id: packageId(name),
		dependsOn: [Sui, options.publisher],
		kind: 'leaf-long-running',
		rebootCost: 'heavy',
		watch: {
			paths: [
				`${options.sourcePath}/**/*.move`,
				`${options.sourcePath}/Move.toml`,
				`${options.sourcePath}/Move.lock`,
			],
			cascade: true,
		},
		start: (_ctx, [, publisher]) => {
			return Effect.succeed({
				name,
				packageId: `${publisher.address}::${name}`,
				sourcePath: options.sourcePath,
			} satisfies PackageValue);
		},
		capabilities: ({ value }) =>
			[
				snapshotable({
					subtrees: [`move/${name}/build`],
					missingTolerance: 'fine',
				}),
				codegenable({
					emitterName: 'package',
					outputPath: `packages/${name}.ts`,
					emit: (writer) =>
						writer.writeTypeScript(
							`export const packageBindings = ${JSON.stringify(
								{
									name,
									packageId: value.packageId,
								},
								null,
								2,
							)};\n`,
						),
				}),
				strategyContributor({
					capabilityKey: 'package-registry',
					strategy: { noteName: name },
					autoMounted: true,
				}),
			],
	});

export const WALLET_ACCOUNTS_ALL = 'all';

export interface WalletOptions<Accounts extends readonly AnyAccountRef[]> {
	readonly accounts?: Accounts | typeof WALLET_ACCOUNTS_ALL;
	readonly allowLocalhostVite?: boolean;
	readonly enableRouter?: boolean;
}

const makeWallet = <const Accounts extends readonly AnyAccountRef[]>(
	options: WalletOptions<Accounts>,
	accounts: Accounts,
) =>
	definePlugin({
		id: 'wallet',
		dependsOn: [Sui, ...accounts],
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		start: (_ctx, deps) => {
			return Effect.succeed({
				url: 'http://wallet.localhost:9100',
				pairUrl: 'http://wallet.localhost:9100/#token=dev',
				accounts: deps.slice(1) as WalletValue<Accounts>['accounts'],
			});
		},
		capabilities: ({ value, runtime }) =>
			[
				snapshotable({
					subtrees: ['wallet/token'],
					missingTolerance: 'fine',
					secretMaterial: true,
				}),
				codegenable({
					emitterName: 'dapp-kit-config',
					outputPath: 'dapp-kit/config.ts',
					sensitive: true,
					emit: (writer) =>
						writer.writeTypeScript(
							`export const dappKitConfig = ${JSON.stringify(
								{
									walletUrl: value.url,
									pairUrl: value.pairUrl,
									chain: runtime.chain,
								},
								null,
								2,
							)};\n`,
						),
				}),
				...(options.enableRouter === true
					? [
							routable({
								endpointName: 'wallet',
								dispatchId: { groupKey: 'wallet', role: 'ui' },
								upstream: { type: 'host-loopback', port: 9100 },
								cors: true,
							}),
						]
					: []),
			],
	});

export function wallet<const Accounts extends readonly AnyAccountRef[]>(
	options: WalletOptions<Accounts> & { readonly accounts: Accounts },
): ReturnType<typeof makeWallet<Accounts>>;
export function wallet(
	options?: Omit<WalletOptions<readonly []>, 'accounts'> & {
		readonly accounts?: typeof WALLET_ACCOUNTS_ALL;
	},
): AnyPlugin;
export function wallet(options: WalletOptions<readonly AnyAccountRef[]> = {}): AnyPlugin {
	const accounts = options.accounts ?? WALLET_ACCOUNTS_ALL;
	if (accounts === WALLET_ACCOUNTS_ALL) {
		return markWalletAll(makeWallet(options as WalletOptions<readonly []>, []), options);
	}
	return makeWallet(options, accounts);
}

const walletAllBrand: unique symbol = Symbol('devstack.prototype.walletAll');

interface WalletAllPlaceholder extends AnyPlugin {
	readonly [walletAllBrand]: true;
	readonly walletOptions: WalletOptions<readonly []>;
}

const markWalletAll = (
	plugin: AnyPlugin,
	options: WalletOptions<readonly AnyAccountRef[]>,
): WalletAllPlaceholder =>
	Object.assign(plugin, {
		[walletAllBrand]: true,
		walletOptions: options as WalletOptions<readonly []>,
	} satisfies Pick<WalletAllPlaceholder, typeof walletAllBrand | 'walletOptions'>);

const isWalletAllPlaceholder = (plugin: AnyPlugin): plugin is WalletAllPlaceholder =>
	(plugin as { readonly [walletAllBrand]?: true })[walletAllBrand] === true;

const expandBuiltinPlaceholders = (members: ReadonlyArray<AnyPlugin>): ReadonlyArray<AnyPlugin> => {
	const accountMembers = members.filter((member): member is ReturnType<typeof account> =>
		member.id.startsWith('account/'),
	);

	return members.map((member) =>
		isWalletAllPlaceholder(member)
			? makeWallet(
					member.walletOptions as unknown as WalletOptions<typeof accountMembers>,
					accountMembers,
				)
			: member,
	);
};

export interface TransactionBuilder {
	readonly moveCall: (options: { readonly target: string }) => void;
}

export interface ActionBodyContext {
	readonly signAndExecute: (
		account: AccountValue,
		build: (tx: TransactionBuilder) => void,
	) => Effect.Effect<ActionReceipt>;
}

type ActionDependencySpec =
	| AnyResourceRef
	| readonly AnyResourceRef[]
	| Readonly<Record<string, AnyResourceRef>>;

export interface ActionOptions<Dependencies extends ActionDependencySpec> {
	readonly dependsOn: Dependencies;
	readonly body: (
		ctx: ActionBodyContext,
		deps: ResolvedDependencies<Dependencies>,
	) => Effect.Effect<ActionReceipt>;
}

const actionId = <const Id extends string>(name: Id): `action:${Id}` =>
	defineId(`action:${name}`);

export const action = <
	const Id extends string,
	const Dependencies extends ActionDependencySpec,
>(
	name: Id,
	options: ActionOptions<Dependencies>,
) => {
	const dependencies = dependencyList(options.dependsOn);

	return definePlugin({
		id: actionId(name),
		dependsOn: [Sui, ...dependencies],
		kind: 'leaf-one-shot',
		rebootCost: 'cheap',
		start: (_ctx, deps) => {
			const actionCtx = {
				signAndExecute: () => Effect.succeed({ name, digest: `digest_${name}` }),
			} satisfies ActionBodyContext;
			const [, ...actionValues] = deps as readonly unknown[];
			return options
				.body(actionCtx, reshapeDependencies(options.dependsOn, actionValues))
				.pipe(Effect.map((receipt) => ({ name, digest: receipt.digest })));
		},
		errorContributions: [
			{
				_tag: 'PluginErrorContribution',
				errorTags: ['ActionError'],
			},
		],
	});
};

const reshapeDependencies = <Dependencies extends ActionDependencySpec>(
	dependsOn: Dependencies,
	values: ReadonlyArray<unknown>,
): ResolvedDependencies<Dependencies> => {
	if (Array.isArray(dependsOn)) {
		return values as ResolvedDependencies<Dependencies>;
	}
	if (isResourceRef(dependsOn)) {
		return values[0] as ResolvedDependencies<Dependencies>;
	}
	return Object.fromEntries(
		Object.keys(dependsOn).map((key, index) => [key, values[index]]),
	) as ResolvedDependencies<Dependencies>;
};

export interface HostServiceOptions<
	Name extends string,
	DependsOn extends DependencyInput | undefined,
> {
	readonly name: Name;
	readonly command: string;
	readonly port: number;
	readonly dependsOn?: DependsOn;
	readonly env?: (
		ctx: StartContext,
		deps: ResolvedDependencies<DependsOn>,
	) => Readonly<Record<string, string>>;
}

const hostServiceId = <const Id extends string>(name: Id): `host-service/${Id}` =>
	defineId(`host-service/${name}`);

export const hostService = <
	const Name extends string,
	const DependsOn extends DependencyInput | undefined = undefined,
>(
	options: HostServiceOptions<Name, DependsOn>,
) => {
	const buildValue = (
		ctx: StartContext,
		deps: ResolvedDependencies<DependsOn>,
	) => {
		const env = options.env?.(ctx, deps) ?? {};
		return Effect.succeed({
			url: `http://127.0.0.1:${options.port}`,
			port: options.port,
			env,
		});
	};
	const capabilities = ({ value }: { readonly value: HostServiceValue }) =>
		[
			routable({
				endpointName: options.name,
				dispatchId: { groupKey: options.name, role: 'http' },
				upstream: { type: 'host-loopback', port: value.port },
				cors: true,
			}),
		];

	if (options.dependsOn === undefined) {
		return definePlugin({
			id: hostServiceId(options.name),
			kind: 'leaf-long-running',
			rebootCost: 'cheap',
			start: (ctx) => buildValue(ctx, undefined as ResolvedDependencies<DependsOn>),
			capabilities,
		});
	}

	return definePlugin({
		id: hostServiceId(options.name),
		dependsOn: options.dependsOn,
		kind: 'leaf-long-running',
		rebootCost: 'cheap',
		start: (ctx, deps: ResolvedDependencies<DependsOn>) => buildValue(ctx, deps),
		capabilities,
	});
};

type ProvidesSui<Members extends readonly AnyPlugin[]> = Extract<
	Members[number]['id'],
	'sui'
> extends never
	? false
	: true;

type DependsOnSui<Members extends readonly AnyPlugin[]> = Extract<
	Members[number]['dependsOn'][number]['id'],
	'sui'
> extends never
	? false
	: true;

type WithAutoSui<Members extends readonly AnyPlugin[]> = ProvidesSui<Members> extends true
	? Members
	: DependsOnSui<Members> extends true
		? readonly [ReturnType<typeof sui>, ...Members]
		: Members;

type ValidateRootMembers<Members extends readonly AnyPlugin[]> = [DuplicateIds<Members>] extends [
	never,
]
	? unknown
	: DuplicateProviderError<DuplicateIds<Members>>;

type ValidateWithBuiltins<Members extends readonly AnyPlugin[]> = ValidateRootMembers<Members> &
	ValidateStack<WithAutoSui<DependencyClosure<Members>>>;

const autoMountSui = (members: ReadonlyArray<AnyPlugin>): ReadonlyArray<AnyPlugin> => {
	const providesSui = members.some((member) => member.id === 'sui');
	const dependsOnSui = members.some((member) =>
		member.dependsOn.some((dependency) => dependency.id === 'sui'),
	);
	return providesSui || !dependsOnSui ? members : [sui(), ...members];
};

export interface DevstackConfig<Members extends readonly AnyPlugin[]> extends DevstackOptions {
	readonly members: Members;
}

export interface DevstackBuildContext<Network extends NetworkConfig> {
	readonly network: Network;
}

export interface DevstackWithConfig<Network extends NetworkConfig>
	extends Omit<DevstackOptions, 'network'> {
	readonly network: Network;
}

export function defineDevstack<const Members extends readonly AnyPlugin[]>(
	config: DevstackConfig<Members> & ValidateWithBuiltins<Members>,
): DevstackStack<WithAutoSui<DependencyClosure<Members>>>;
export function defineDevstack(
	config: DevstackConfig<readonly AnyPlugin[]>,
): DevstackStack<readonly AnyPlugin[]> {
	const roots = expandBuiltinPlaceholders(config.members);
	const expandedRoots = expandPluginDependencies(roots);
	const expandedWithBuiltins = expandBuiltinPlaceholders(expandedRoots);
	const expanded = expandPluginDependencies(expandedWithBuiltins);
	const options = {
		...(config.stackName === undefined ? {} : { stackName: config.stackName }),
		...(config.network === undefined ? {} : { network: config.network }),
		...(config.codegen === undefined ? {} : { codegen: config.codegen }),
	} satisfies DevstackOptions;
	return createDevstackStack(autoMountSui(expanded) as readonly AnyPlugin[], options);
}

export function defineDevstackWith<
	const Network extends NetworkConfig,
	const Members extends readonly AnyPlugin[],
>(
	config: DevstackWithConfig<Network>,
	build: (ctx: DevstackBuildContext<Network>) => Members & ValidateWithBuiltins<Members>,
): DevstackStack<WithAutoSui<DependencyClosure<Members>>>;
export function defineDevstackWith(
	config: DevstackWithConfig<NetworkConfig>,
	build: (ctx: DevstackBuildContext<NetworkConfig>) => readonly AnyPlugin[],
): DevstackStack<readonly AnyPlugin[]> {
	const members = build({ network: config.network });
	for (const member of members) {
		if (!isPlugin(member)) {
			throw new Error(
				'defineDevstackWith: builder returned a value that is not a plugin member',
			);
		}
	}

	return defineDevstack({
		members,
		...(config.stackName === undefined ? {} : { stackName: config.stackName }),
		network: config.network,
		...(config.codegen === undefined ? {} : { codegen: config.codegen }),
	});
}
