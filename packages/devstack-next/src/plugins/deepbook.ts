import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import type { Package } from '../shapes/index.js';

// Pinned canonical DeepBook v3 ids per network. These come from
// `@mysten/deepbook-v3/utils/constants.ts` — copy them locally so the
// plugin doesn't drag the SDK as a runtime dep just to expose the
// addresses. Bumping the SDK version isn't required to use these IDs;
// the plugin is a static lookup, not a wrapper.
//
// localnet has no canonical deployment — users would `deepbook.publish`
// the source themselves (deferred to a future plugin per STATE.md).
const DEEPBOOK_PACKAGE_IDS = {
	testnet: {
		DEEPBOOK_PACKAGE_ID: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
		REGISTRY_ID: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
		DEEP_TREASURY_ID: '0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb',
		MARGIN_PACKAGE_ID: '0xd6a42f4df4db73d68cbeb52be66698d2fe6a9464f45ad113ca52b0c6ebd918b6',
		MARGIN_REGISTRY_ID: '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75',
		LIQUIDATION_PACKAGE_ID: '0x8d69c3ef3ef580e5bf87b933ce28de19a5d0323588d1a44b9c60b4001741aa24',
	},
	mainnet: {
		DEEPBOOK_PACKAGE_ID: '0xf48222c4e057fa468baf136bff8e12504209d43850c5778f76159292a96f621e',
		REGISTRY_ID: '0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d',
		DEEP_TREASURY_ID: '0x032abf8948dda67a271bcc18e776dbbcfb0d58c8d288a700ff0d5521e57a1ffe',
		MARGIN_PACKAGE_ID: '0xfbd322126f1452fd4c89aedbaeb9fd0c44df9b5cedbe70d76bf80dc086031377',
		MARGIN_REGISTRY_ID: '0x0e40998b359a9ccbab22a98ed21bd4346abf19158bc7980c8291908086b3a742',
		LIQUIDATION_PACKAGE_ID: '0x55718c06706bee34c9f3c39f662f10be354a4dcc719699ad72091dc343b641b8',
	},
} as const;

export type DeepbookNetwork = keyof typeof DEEPBOOK_PACKAGE_IDS;

export interface DeepbookOptions {
	/** Override which network's pre-deployed addresses to publish. Defaults
	 * to the engine's `env.network` (when it's testnet or mainnet). Throws
	 * if the resolved network has no canonical DeepBook deployment
	 * (localnet, devnet). */
	network?: DeepbookNetwork;
}

export interface DeepbookState {
	network: DeepbookNetwork;
	packageId: string;
	registryId: string;
	deepTreasuryId: string;
	marginPackageId: string;
	marginRegistryId: string;
	liquidationPackageId: string;
}

const provides = {
	package: dep((s: DeepbookState): Package => ({ name: 'deepbook', packageId: s.packageId })),
	marginPackage: dep(
		(s: DeepbookState): Package => ({ name: 'deepbook-margin', packageId: s.marginPackageId }),
	),
	registryId: dep((s: DeepbookState) => s.registryId),
	deepTreasuryId: dep((s: DeepbookState) => s.deepTreasuryId),
	marginRegistryId: dep((s: DeepbookState) => s.marginRegistryId),
	liquidationPackageId: dep((s: DeepbookState) => s.liquidationPackageId),
	full: dep((s: DeepbookState) => s),
} satisfies Provides<DeepbookState>;

// `deepbook(opts)` — static pre-deployed-addresses producer.
//
// No container, no on-chain calls. Just publishes the canonical DeepBook
// v3 package ids + registry / treasury object ids for the chosen
// network. Consumers (frontend SDK, manifest, bindings) read them via
// `deepbook.get('package')` etc.
//
// Network resolution:
//   - opts.network set → use that.
//   - opts.network unset, env.network is testnet|mainnet → use it.
//   - otherwise → throw at start (localnet/devnet have no canonical IDs).
//
// This is the simplest plugin shape: a plain function returning a single
// `define()`-built producer. No schema split, no dockerContainer, no
// hostProcess.
export function deepbook(opts: DeepbookOptions = {}) {
	return define<DeepbookState, typeof provides>({
		name: 'deepbook',
		provides,
		start: async ({ env }): Promise<DeepbookState> => {
			const network = resolveNetwork(opts.network, env.network);
			const ids = DEEPBOOK_PACKAGE_IDS[network];
			return {
				network,
				packageId: ids.DEEPBOOK_PACKAGE_ID,
				registryId: ids.REGISTRY_ID,
				deepTreasuryId: ids.DEEP_TREASURY_ID,
				marginPackageId: ids.MARGIN_PACKAGE_ID,
				marginRegistryId: ids.MARGIN_REGISTRY_ID,
				liquidationPackageId: ids.LIQUIDATION_PACKAGE_ID,
			};
		},
		represents: {
			packages: (s: DeepbookState): Package[] => [
				{ name: 'deepbook', packageId: s.packageId },
				{ name: 'deepbook-margin', packageId: s.marginPackageId },
			],
		},
	});
}

function resolveNetwork(
	override: DeepbookNetwork | undefined,
	envNetwork: string,
): DeepbookNetwork {
	if (override !== undefined) return override;
	if (envNetwork === 'testnet' || envNetwork === 'mainnet') return envNetwork;
	throw new Error(
		`deepbook: no canonical deployment for network '${envNetwork}'. ` +
			`Pass network: 'testnet' | 'mainnet' explicitly, or run on a network that has one.`,
	);
}
