import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

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

/** Normalize a candidate name: trim, strip an `@scope/` prefix, then
 *  strip any leading non-alphanumeric run. Returns `undefined` for empty
 *  or whitespace-only input, and for inputs that normalize to an empty
 *  string. Shared by every inferred-name resolver so explicit / env /
 *  package paths all reject the same junk. */
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

/** Shared `explicit > env > package > default` precedence ladder for the
 *  app/stack name resolvers. Each input is fed through `usefulName` so a
 *  whitespace-only or junk-prefixed value falls through to the next rung
 *  rather than poisoning identity. `envKey` is the environment variable
 *  whose value (under `env`) supplies the env rung. */
const resolveInferredName = (params: {
	readonly explicit: string | undefined;
	readonly envKey: string;
	readonly env: Readonly<Record<string, string | undefined>> | undefined;
	readonly cwd: string | undefined;
	readonly defaultName: string;
}): string => {
	const explicit = usefulName(params.explicit);
	if (explicit !== undefined) return explicit;
	const env = params.env ?? process.env;
	const fromEnv = usefulName(env[params.envKey]);
	if (fromEnv !== undefined) return fromEnv;
	const fromPackage = inferPackageNameFromCwd(params.cwd);
	if (fromPackage !== undefined) return fromPackage;
	return params.defaultName;
};

export const resolveStackName = (options: StackNameResolutionOptions = {}): string =>
	resolveInferredName({
		explicit: options.explicit,
		envKey: 'DEVSTACK_STACK',
		env: options.env,
		cwd: options.cwd,
		defaultName: options.defaultName ?? DEFAULT_STACK_NAME,
	});

export const resolveAppName = (options: AppNameResolutionOptions = {}): string =>
	resolveInferredName({
		explicit: options.explicit,
		envKey: 'DEVSTACK_APP',
		env: options.env,
		cwd: options.cwd,
		defaultName: options.defaultName ?? 'devstack',
	});

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
	  }
	| {
			readonly mode: 'fork';
			readonly name: ForkDevstackNetworkName;
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
		case 'mainnet-fork':
		case 'devnet-fork':
			return {
				mode: 'fork',
				name,
				upstream: name.replace(/-fork$/, '') as LiveDevstackNetworkName,
			};
	}
};

export const parseDevstackNetworkName = (
	value: string | undefined,
	source = 'DEVSTACK_NETWORK',
): DevstackNetworkName => parseDevstackNetwork(value, source).name;

// ---------------------------------------------------------------------------
// resolveNetwork — single precedence ladder for every entry point.
// ---------------------------------------------------------------------------

/**
 * Options for `resolveNetwork`. `explicit` is the caller-supplied
 * override (typically a CLI flag or programmatic option). `env` is the
 * environment value (typically `process.env.DEVSTACK_NETWORK`).
 * `defaultName` is the final fallback when both miss. The precedence is
 * explicit > env > default. The `source` string is embedded in the
 * parse error's `source` field so the diagnosis names the offending
 * input (e.g. `--network` vs `DEVSTACK_NETWORK`).
 */
export interface ResolveNetworkOptions {
	readonly explicit?: string | undefined;
	readonly env?: string | undefined;
	readonly defaultName?: string;
	readonly explicitSource?: string;
	readonly envSource?: string;
}

/** Default value when neither caller nor env provides one. Kept as a
 *  string (not a `ParsedDevstackNetwork`) because every call site folds
 *  it through `parseDevstackNetwork` first — keeping the default in the
 *  same lookup table the env value flows through avoids two source-of-
 *  truth shapes for "what is the default network?". */
export const DEFAULT_DEVSTACK_NETWORK = 'sui:local' as const;

/**
 * Result shape — both the typed parse AND the original input string the
 * resolver picked. Consumers that thread the value through chain-keyed
 * caches (the substrate folds chain id into cache namespaces) MUST keep
 * the raw form to preserve existing on-disk cache keys; consumers that
 * branch on mode (local/live/fork) read `parsed`.
 */
export interface ResolvedDevstackNetwork {
	readonly raw: string;
	readonly parsed: ParsedDevstackNetwork;
}

const pickInput = (
	options: ResolveNetworkOptions,
): { readonly value: string; readonly source: string } => {
	if (options.explicit !== undefined && options.explicit.length > 0) {
		return { value: options.explicit, source: options.explicitSource ?? '--network' };
	}
	if (options.env !== undefined && options.env.length > 0) {
		return { value: options.env, source: options.envSource ?? 'DEVSTACK_NETWORK' };
	}
	return { value: options.defaultName ?? DEFAULT_DEVSTACK_NETWORK, source: 'default' };
};

/**
 * Resolve a network from the canonical explicit > env > default ladder
 * and parse the winning value through `parseDevstackNetwork`. Returns
 * the typed parse alongside the raw input the resolver picked. A
 * malformed value surfaces as `DevstackNetworkParseError` on the
 * failure channel so CLI / library boot fail fast with a structured
 * error rather than a downstream cryptic message.
 *
 * Used by both `api/run-stack.ts` (library embedding) and the CLI
 * identity resolver so the two paths share one precedence rule + one
 * parse error type.
 */
export const resolveNetwork = (
	options: ResolveNetworkOptions = {},
): Effect.Effect<ResolvedDevstackNetwork, DevstackNetworkParseError> =>
	Effect.try({
		try: (): ResolvedDevstackNetwork => {
			const { value, source } = pickInput(options);
			return { raw: value, parsed: parseDevstackNetwork(value, source) };
		},
		catch: (cause) => cause as DevstackNetworkParseError,
	});

/**
 * Sync sibling of `resolveNetwork` for entry points that aren't running
 * inside an Effect (the CLI identity resolver builds a plain TS record).
 * Throws `DevstackNetworkParseError` on bad input — caller's job to lift
 * into a typed failure channel if needed.
 */
export const resolveNetworkSync = (
	options: ResolveNetworkOptions = {},
): ResolvedDevstackNetwork => {
	const { value, source } = pickInput(options);
	return { raw: value, parsed: parseDevstackNetwork(value, source) };
};

// ---------------------------------------------------------------------------
// resolveStateDir — single precedence ladder for the on-disk runtime root.
// ---------------------------------------------------------------------------

export interface ResolveStateDirOptions {
	/** Caller-supplied `runtimeRoot` override (the canonical
	 *  `RunStackOptions.runtimeRoot` / CLI `--state-dir` field). Wins
	 *  over every other input. */
	readonly runtimeRoot?: string;
	/** Caller-supplied `stateDir` override (the
	 *  `DevstackOptions.stateDir` field on `defineDevstack(...)`).
	 *  Lower precedence than `runtimeRoot`. */
	readonly stateDir?: string;
	/** Env-var value (typically `process.env.DEVSTACK_STATE_DIR`).
	 *  Lower precedence than either explicit override. */
	readonly env?: string;
	/** Working directory used for the `.devstack` fallback and for
	 *  resolving any relative override path. */
	readonly cwd: string;
}

/**
 * Resolve the substrate's on-disk runtime root using the canonical
 * precedence ladder: `runtimeRoot` > `stateDir` > `env` > `<cwd>/.devstack`.
 * Relative paths are resolved against `cwd`; absolute paths pass through.
 *
 * Shared by `runStack`, the CLI bin, and the build-integrations
 * discover module so all three entry points agree on the same ladder.
 */
export const resolveStateDir = (options: ResolveStateDirOptions): string => {
	const pick =
		(options.runtimeRoot !== undefined && options.runtimeRoot.length > 0
			? options.runtimeRoot
			: undefined) ??
		(options.stateDir !== undefined && options.stateDir.length > 0
			? options.stateDir
			: undefined) ??
		(options.env !== undefined && options.env.length > 0 ? options.env : undefined);
	if (pick === undefined) return resolve(options.cwd, '.devstack');
	return resolve(options.cwd, pick);
};
