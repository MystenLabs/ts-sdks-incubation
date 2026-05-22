import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_STACK_NAME = 'main';

export interface StackNameResolutionOptions {
	readonly explicit?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cwd?: string;
	readonly defaultName?: string;
}

export interface AppNameResolutionOptions {
	readonly explicit?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cwd?: string;
	readonly defaultName?: string;
}

const usefulName = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	const unscoped = trimmed.replace(/^@[^/]+\//, '').replace(/^[^a-zA-Z0-9]+/, '');
	return unscoped.length > 0 ? unscoped : undefined;
};

export const readPackageName = (dir: string): string | undefined => {
	try {
		const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
			readonly name?: string;
		};
		return typeof pkg.name === 'string' ? usefulName(pkg.name) : undefined;
	} catch {
		return undefined;
	}
};

export const inferPackageNameFromCwd = (cwd: string = process.cwd()): string | undefined => {
	let dir = resolve(cwd);
	for (let i = 0; i < 32; i += 1) {
		const name = readPackageName(dir);
		if (name !== undefined) return name;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
};

export const resolveStackName = (options: StackNameResolutionOptions = {}): string => {
	const explicit = usefulName(options.explicit);
	if (explicit !== undefined) return explicit;
	const env = options.env ?? process.env;
	const fromEnv = usefulName(env.DEVSTACK_STACK);
	if (fromEnv !== undefined) return fromEnv;
	const fromPackage = inferPackageNameFromCwd(options.cwd);
	if (fromPackage !== undefined) return fromPackage;
	return options.defaultName ?? DEFAULT_STACK_NAME;
};

export const resolveAppName = (options: AppNameResolutionOptions = {}): string => {
	const explicit = usefulName(options.explicit);
	if (explicit !== undefined) return explicit;
	const env = options.env ?? process.env;
	const fromEnv = usefulName(env.DEVSTACK_APP);
	if (fromEnv !== undefined) return fromEnv;
	const fromPackage = inferPackageNameFromCwd(options.cwd);
	if (fromPackage !== undefined) return fromPackage;
	return options.defaultName ?? 'devstack';
};

export const ACTIVE_DEVSTACK_NETWORK_NAMES = ['localnet', 'testnet', 'mainnet', 'devnet'] as const;

export const FORK_DEVSTACK_NETWORK_NAMES = ['testnet-fork', 'mainnet-fork', 'devnet-fork'] as const;

export const DEVSTACK_NETWORK_NAMES = [
	...ACTIVE_DEVSTACK_NETWORK_NAMES,
	...FORK_DEVSTACK_NETWORK_NAMES,
] as const;

export type ActiveDevstackNetworkName = (typeof ACTIVE_DEVSTACK_NETWORK_NAMES)[number];
export type ForkDevstackNetworkName = (typeof FORK_DEVSTACK_NETWORK_NAMES)[number];
export type DevstackNetworkName = (typeof DEVSTACK_NETWORK_NAMES)[number];
export type LiveDevstackNetworkName = 'testnet' | 'mainnet' | 'devnet';

export type ParsedDevstackNetwork =
	| {
			readonly mode: 'local';
			readonly name: 'localnet';
	  }
	| {
			readonly mode: 'live';
			readonly name: LiveDevstackNetworkName;
			readonly network: LiveDevstackNetworkName;
	  };

const NETWORK_ALIASES: Readonly<Record<string, DevstackNetworkName>> = {
	local: 'localnet',
	localnet: 'localnet',
	'sui:local': 'localnet',
	'sui:localnet': 'localnet',
	testnet: 'testnet',
	'sui:testnet': 'testnet',
	mainnet: 'mainnet',
	'sui:mainnet': 'mainnet',
	devnet: 'devnet',
	'sui:devnet': 'devnet',
	'testnet-fork': 'testnet-fork',
	'sui:testnet-fork': 'testnet-fork',
	'mainnet-fork': 'mainnet-fork',
	'sui:mainnet-fork': 'mainnet-fork',
	'devnet-fork': 'devnet-fork',
	'sui:devnet-fork': 'devnet-fork',
};

export class DevstackNetworkParseError extends Error {
	readonly _tag = 'DevstackNetworkParseError';
	readonly value: string;
	readonly source: string;
	readonly supported: ReadonlyArray<ActiveDevstackNetworkName>;

	constructor(args: { readonly value: string; readonly source: string }) {
		super(
			`${args.source} must be one of: ${ACTIVE_DEVSTACK_NETWORK_NAMES.join(', ')} (got ${JSON.stringify(args.value)})`,
		);
		this.name = 'DevstackNetworkParseError';
		this.value = args.value;
		this.source = args.source;
		this.supported = ACTIVE_DEVSTACK_NETWORK_NAMES;
	}
}

export class DevstackNetworkComingSoonError extends Error {
	readonly _tag = 'DevstackNetworkComingSoonError';
	readonly value: string;
	readonly source: string;
	readonly feature = 'fork' as const;
	readonly supported: ReadonlyArray<ActiveDevstackNetworkName>;
	readonly comingSoon: ReadonlyArray<ForkDevstackNetworkName>;

	constructor(args: { readonly value: string; readonly source: string }) {
		super(
			`${args.source} fork networks are coming soon; use one of ${ACTIVE_DEVSTACK_NETWORK_NAMES.join(', ')} for now (got ${JSON.stringify(args.value)})`,
		);
		this.name = 'DevstackNetworkComingSoonError';
		this.value = args.value;
		this.source = args.source;
		this.supported = ACTIVE_DEVSTACK_NETWORK_NAMES;
		this.comingSoon = FORK_DEVSTACK_NETWORK_NAMES;
	}
}

const isForkNetworkName = (name: DevstackNetworkName): name is ForkDevstackNetworkName =>
	(FORK_DEVSTACK_NETWORK_NAMES as ReadonlyArray<string>).includes(name);

export const parseDevstackNetwork = (
	value: string | undefined,
	source = 'DEVSTACK_NETWORK',
): ParsedDevstackNetwork => {
	const raw = value?.trim();
	const name = raw === undefined || raw.length === 0 ? 'localnet' : NETWORK_ALIASES[raw];
	if (name === undefined) {
		throw new DevstackNetworkParseError({ value: raw ?? '', source });
	}
	if (isForkNetworkName(name)) {
		throw new DevstackNetworkComingSoonError({ value: raw ?? name, source });
	}
	switch (name) {
		case 'localnet':
			return { mode: 'local', name };
		case 'testnet':
		case 'mainnet':
		case 'devnet':
			return { mode: 'live', name, network: name };
	}
};

export const parseDevstackNetworkName = (
	value: string | undefined,
	source = 'DEVSTACK_NETWORK',
): ActiveDevstackNetworkName => parseDevstackNetwork(value, source).name;
