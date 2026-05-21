import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_STACK_NAME = 'main';

export interface StackNameResolutionOptions {
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

export const DEVSTACK_NETWORK_NAMES = [
	'localnet',
	'testnet',
	'mainnet',
	'devnet',
	'testnet-fork',
	'mainnet-fork',
	'devnet-fork',
] as const;

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
	  }
	| {
			readonly mode: 'fork';
			readonly name: `${LiveDevstackNetworkName}-fork`;
			readonly upstream: LiveDevstackNetworkName;
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
	readonly supported: ReadonlyArray<DevstackNetworkName>;

	constructor(args: { readonly value: string; readonly source: string }) {
		super(
			`${args.source} must be one of: ${DEVSTACK_NETWORK_NAMES.join(', ')} (got ${JSON.stringify(args.value)})`,
		);
		this.name = 'DevstackNetworkParseError';
		this.value = args.value;
		this.source = args.source;
		this.supported = DEVSTACK_NETWORK_NAMES;
	}
}

export const parseDevstackNetwork = (
	value: string | undefined,
	source = 'DEVSTACK_NETWORK',
): ParsedDevstackNetwork => {
	const raw = value?.trim();
	const name = raw === undefined || raw.length === 0 ? 'localnet' : NETWORK_ALIASES[raw];
	if (name === undefined) {
		throw new DevstackNetworkParseError({ value: raw ?? '', source });
	}
	switch (name) {
		case 'localnet':
			return { mode: 'local', name };
		case 'testnet':
		case 'mainnet':
		case 'devnet':
			return { mode: 'live', name, network: name };
		case 'testnet-fork':
			return { mode: 'fork', name, upstream: 'testnet' };
		case 'mainnet-fork':
			return { mode: 'fork', name, upstream: 'mainnet' };
		case 'devnet-fork':
			return { mode: 'fork', name, upstream: 'devnet' };
	}
};

export const parseDevstackNetworkName = (
	value: string | undefined,
	source = 'DEVSTACK_NETWORK',
): DevstackNetworkName => parseDevstackNetwork(value, source).name;
