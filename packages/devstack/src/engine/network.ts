// resolveNetwork — single source of truth for which Sui network this
// devstack run is targeting. Read at factory-call time (NOT acquire
// time) by every network-aware factory (`Sui`, `Seal`, `Walrus`,
// `Deepbook`) so the user's config composes the same Refs regardless
// of network — the factory body branches internally.
//
// Resolution order:
//   1. `DEVSTACK_NETWORK` env var (`'localnet' | 'testnet' | 'mainnet'`).
//   2. `'localnet'` default.
//
// The CLI sets `DEVSTACK_NETWORK` from its `--network` flag BEFORE
// dynamic-importing the user's `devstack.config.ts`, so every factory
// call inside the config sees the same value.
//
// User code that wants to pin a network programmatically can either:
//   - set `process.env.DEVSTACK_NETWORK = 'testnet'` at the top of
//     `devstack.config.ts` (before any factory call), or
//   - pass an explicit `Sui({ network: { rpc, faucet } })` for custom
//     RPCs (corporate fullnodes, pinned forks).

/** Network literal alias. Lives in `engine/` because the substrate
 *  (state-store cache paths, identity, supervisor, network resolution)
 *  is the primary consumer; `services/sui.ts` re-exports it so
 *  user-facing types still come from the high-level module.
 *
 *  Fork variants (`'mainnet-fork'` / `'testnet-fork'` / `'devnet-fork'`)
 *  flow through the same routing as `'localnet'` (per-stack state-store
 *  path layout, no shared `.devstack/networks/<network>.json` file)
 *  because each fork has per-stack mutable chain state — see D1 in
 *  `notes/sui-fork-integration.md`. The wrapped upstream's real
 *  `chainId` still flows through `sui.chainId`; only the substrate-
 *  level routing diverges.
 */
export type SuiNetwork =
	| 'localnet'
	| 'testnet'
	| 'mainnet'
	| 'mainnet-fork'
	| 'testnet-fork'
	| 'devnet-fork';

/** Subset of `SuiNetwork` that `resolveNetwork()` can return — the
 *  three live-net + localnet identifiers users can set via the
 *  `DEVSTACK_NETWORK` env var, plus the three fork variants. The CLI
 *  `--network`
 *  flag is narrower today (only the three base networks); fork
 *  variants reach this resolver via the env var being set directly
 *  (e.g. inside a `devstack.config.ts` shim) or via `Sui({network})`
 *  pre-seeding `process.env.DEVSTACK_NETWORK` for downstream plugin
 *  factories.
 */
export type ResolvedNetwork = SuiNetwork;

const ENV_RESOLVABLE_NETWORKS: ReadonlyArray<ResolvedNetwork> = [
	'localnet',
	'testnet',
	'mainnet',
	'mainnet-fork',
	'testnet-fork',
	'devnet-fork',
];

/** All `SuiNetwork` literals — including fork variants — that pass the
 *  factory's network-name validator. Kept separate from
 *  `ENV_RESOLVABLE_NETWORKS` so the env-var path narrows correctly.
 */
const KNOWN_NETWORKS: ReadonlyArray<SuiNetwork> = [
	'localnet',
	'testnet',
	'mainnet',
	'mainnet-fork',
	'testnet-fork',
	'devnet-fork',
];

/** Resolve the target Sui network from the environment. Returns
 *  `'localnet'` as the default when `DEVSTACK_NETWORK` is unset.
 *  Throws on unrecognized values. Fork variants are not resolvable
 *  here — pass them explicitly to `Sui({network: 'mainnet-fork'})`. */
export const resolveNetwork = (): ResolvedNetwork => {
	const raw = process.env.DEVSTACK_NETWORK;
	if (raw === undefined) return 'localnet';
	const normalized = raw.trim().toLowerCase();
	if (ENV_RESOLVABLE_NETWORKS.includes(normalized as ResolvedNetwork)) {
		return normalized as ResolvedNetwork;
	}
	throw new Error(
		`DEVSTACK_NETWORK="${raw}" is not a recognized Sui network. ` +
			`Expected one of: ${ENV_RESOLVABLE_NETWORKS.join(', ')}. ` +
			`(Fork variants like "mainnet-fork" must be set per-stack via ` +
			`Sui({network: '...'}); env-var resolution is reserved for the ` +
			`three base networks.)`,
	);
};

/** Whether a string is a recognized `SuiNetwork` literal. Exported for
 *  callers that need to validate a free-form network value (e.g. the
 *  CLI's `--network` flag). */
export const isKnownNetwork = (value: string): value is SuiNetwork =>
	(KNOWN_NETWORKS as ReadonlyArray<string>).includes(value);

/** Whether the current network is "local-like" — owns per-stack
 *  mutable chain state (under `.devstack/stacks/<stack>/`) rather than
 *  pointing at a shared live-net cache (`.devstack/networks/<net>.json`).
 *  True for `'localnet'` (vendored sui-localnet container) and for any
 *  fork variant (`*-fork`), all of which have writable per-stack chain
 *  state that diverges from the upstream.
 */
export const isLocalLikeNetwork = (network: SuiNetwork): boolean =>
	network === 'localnet' || network.endsWith('-fork');

/** Whether the current network is a live network (a chain we don't
 *  own — public testnet / mainnet). Composite factories use this to
 *  decide whether to boot local infra or wire to the canonical remote
 *  deployment. Fork variants return `false` because the fork IS the
 *  local infra — even though the upstream is live, the local container
 *  is what we talk to. */
export const isLiveNetwork = (network: SuiNetwork): boolean => !isLocalLikeNetwork(network);

/** Translate a fork variant to its upstream live-net counterpart.
 *  Returns the input unchanged when the network isn't a fork variant.
 *  Used by codegen (so dapp-kit sees the real `'mainnet'`) and by the
 *  KnownPackage / KnownDeployment branches (so they look up real
 *  package addresses against the wrapped chain).
 */
export const stripForkSuffix = (
	network: SuiNetwork,
): 'localnet' | 'testnet' | 'mainnet' | 'devnet' | SuiNetwork => {
	if (network === 'mainnet-fork') return 'mainnet';
	if (network === 'testnet-fork') return 'testnet';
	if (network === 'devnet-fork') return 'devnet';
	return network;
};
