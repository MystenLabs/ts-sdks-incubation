import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Effect } from 'effect';

/** Canonical default stack name (`'main'`). The literal's single source
 *  of truth lives HERE: the discovery ladder
 *  (`build-integrations/runtime/resolve-discovery-env.ts`) imports
 *  `inferPackageNameFromCwd` from this module for its package-name
 *  rung, so this module must not import the ladder's consts back — a
 *  two-way top-level-const read would TDZ-crash under one import
 *  order. The ladder re-exports this value as `DEFAULT_DISCOVERY_STACK`
 *  (and the vitest env module as its own `DEFAULT_STACK_NAME`) so all
 *  entry points still agree on one literal. */
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

/** The network every local stack actually runs, and the active key in the
 *  generated `config.ts` (`config.network`, `networks.<key>`). A fork runs on
 *  a local node too, so this is `localnet` for every mode — the fork's
 *  upstream identity lives separately in the network entry's `forkUpstream`.
 *  The sui and package codegen contributions share this one literal so their
 *  active-network keys can never drift. */
export const LOCAL_NETWORK_NAME = 'localnet' satisfies DevstackNetworkName;

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

/** Canonical network names accepted as input. There is no alias table:
 *  a network has ONE spelling (`localnet`, `testnet`, …). The chain id is
 *  that name with a `sui:` prefix (see {@link chainIdForNetwork}); the reverse
 *  is stripping the prefix (see {@link networkNameFromChain}). */
const NETWORK_NAME_SET: ReadonlySet<string> = new Set(DEVSTACK_NETWORK_NAMES);

/** The sole network→chain mapping: prefix the canonical name with `sui:`.
 *  `localnet` → `sui:localnet`, `testnet` → `sui:testnet`. No lookup table. */
export const chainIdForNetwork = (name: DevstackNetworkName): string => `sui:${name}`;

/** Inverse of {@link chainIdForNetwork}: strip the `sui:` prefix to recover the
 *  network name. Returns the input unchanged if it carries no prefix. */
export const networkNameFromChain = (chain: string): string => chain.replace(/^sui:/, '');

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
	const candidate = raw === undefined || raw.length === 0 ? 'localnet' : raw;
	if (!NETWORK_NAME_SET.has(candidate)) {
		throw new DevstackNetworkParseError({ value: raw ?? '', source });
	}
	const name = candidate as DevstackNetworkName;
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

/** Default network when neither caller nor env provides one — the canonical
 *  name (not a chain id or a `ParsedDevstackNetwork`), because every call site
 *  folds it through `parseDevstackNetwork` first, exactly like an env value. */
export const DEFAULT_DEVSTACK_NETWORK = 'localnet' as const;

/**
 * Result shape — the typed parse of the network the resolver picked.
 * Consumers branch on `parsed.mode` (local/live/fork) or derive the chain id
 * via `chainIdForNetwork(parsed.name)`; there is no second "raw spelling"
 * field, because the chain id is canonical and never depends on input form.
 */
export interface ResolvedDevstackNetwork {
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
			return { parsed: parseDevstackNetwork(value, source) };
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
	return { parsed: parseDevstackNetwork(value, source) };
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
