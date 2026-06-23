// Seal live mode — testnet / mainnet known key server.
//
// Distilled-doc §"Startup — `sealKnownKeyServer`": far simpler than
// the local-keygen path.
//
//   1. Resolve the requested deployment (independent servers vs the
//      committee aggregator) into a `serverConfigs` array.
//   2. Publish the resolved key-server endpoint as the plugin's
//      resource (the codegen + manifest emitters consume it).
//   3. Return the read-side handle.
//
// NO chain interactions, NO docker, NO on-disk persistence, NO
// keygen. Distilled-doc invariant #15 — the manager tag is NOT
// produced (we don't own the master key for a remote deployment).
//
// Known-deployment table (real Mysten ids):
//   - testnet INDEPENDENT: two Open-mode servers, weight 1 each. This
//     is the zero-config default (`sealFor(net).testnet()`).
//   - testnet COMMITTEE: a single 3-of-5 committee object reached
//     through the testnet aggregator. Opt in via `{ server: 'committee' }`;
//     no API key required.
//   - mainnet COMMITTEE: a single 5-of-8 committee object reached
//     through the mainnet aggregator. This is the mainnet DEFAULT and
//     REQUIRES an `apiKey`. Mainnet ships NO independent default — so
//     `mainnet({ server: 'independent' })` throws.

import { sealConfigError } from '../errors.ts';
import type { SealKeyServerEntry } from '../registry-publish.ts';

// ---------------------------------------------------------------------------
// Server-kind selector
// ---------------------------------------------------------------------------

/** Which class of known key-server backing to resolve. `independent`
 *  fans out to all of the network's standalone Open-mode servers
 *  (weight 1 each); `committee` resolves the single threshold-committee
 *  object reached through an aggregator. Plugin-INTERNAL — not exported
 *  from the barrel. */
export type SealServerKind = 'independent' | 'committee';

// ---------------------------------------------------------------------------
// Known-deployment table — real Mysten object ids
// ---------------------------------------------------------------------------

/** A single independent (Open-mode) key server. */
interface IndependentServerSpec {
	readonly objectId: string;
	readonly url: string;
}

/** The committee (threshold) deployment for a network. */
interface CommitteeSpec {
	readonly objectId: string;
	readonly aggregatorUrl: string;
	/** Threshold `m-of-n`, carried for diagnostics / display only. */
	readonly threshold: { readonly m: number; readonly n: number };
	/** When `true`, the committee aggregator demands an API key and the
	 *  factory throws `SealConfigError` if the caller omits `apiKey`. */
	readonly requiresApiKey: boolean;
}

/** Per-network known deployment. `independent` is `null` when the
 *  network ships no public standalone server (mainnet); `committee` is
 *  `null` when none ships (devnet). */
interface KnownDeployment {
	readonly independent: ReadonlyArray<IndependentServerSpec> | null;
	readonly committee: CommitteeSpec | null;
	/** The default server kind for zero-config use of this network. */
	readonly defaultServer: SealServerKind;
}

export const KNOWN_DEPLOYMENTS: {
	readonly testnet: KnownDeployment;
	readonly mainnet: KnownDeployment;
	readonly devnet: null;
} = {
	testnet: {
		independent: [
			{
				objectId: '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
				url: 'https://seal-key-server-testnet-1.mystenlabs.com',
			},
			{
				objectId: '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
				url: 'https://seal-key-server-testnet-2.mystenlabs.com',
			},
		],
		committee: {
			objectId: '0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98',
			aggregatorUrl: 'https://seal-aggregator-testnet.mystenlabs.com',
			threshold: { m: 3, n: 5 },
			requiresApiKey: false,
		},
		// Zero-config testnet = BOTH independent servers (locked decision #6).
		defaultServer: 'independent',
	},
	mainnet: {
		// Mainnet ships no public independent default — committee only.
		independent: null,
		committee: {
			objectId: '0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595',
			aggregatorUrl: 'https://seal-aggregator-mainnet.mystenlabs.com',
			threshold: { m: 5, n: 8 },
			requiresApiKey: true,
		},
		defaultServer: 'committee',
	},
	devnet: null,
};

export type KnownNetwork = keyof typeof KNOWN_DEPLOYMENTS;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Live-mode inputs. Either `network` resolves to a known deployment
 *  (optionally narrowed by `server`), OR the user supplies explicit
 *  `serverConfigs` verbatim. Distilled-doc §"Configuration" — the
 *  factory throws synchronously if neither path produces a usable
 *  `serverConfigs` array. */
export interface LiveModeInputs {
	readonly name: string;
	readonly network?: KnownNetwork;
	/** Which known server kind to resolve. Defaults to the network's
	 *  `defaultServer` (testnet→independent, mainnet→committee). */
	readonly server?: SealServerKind;
	/** API-key pair for committee servers that require one (mainnet). */
	readonly apiKeyName?: string;
	readonly apiKey?: string;
	/** Raw override — bypasses the known table entirely. */
	readonly serverConfigs?: ReadonlyArray<SealKeyServerEntry>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The validated/resolved live-mode bundle. `serverConfigs` is the
 *  SDK-ready array; the legacy single `objectId` / `keyServerUrl`
 *  fields are derived from the first entry / chosen url for the
 *  read-side handle + codegen literals that still expect them. */
export interface ResolvedLiveInputs {
	readonly serverConfigs: ReadonlyArray<SealKeyServerEntry>;
	readonly objectId: string;
	readonly keyServerUrl: string;
}

/** Validate + resolve the inputs at the factory boundary. Pure
 *  synchronous function — the plugin `start` body is reserved for
 *  Effect-flavored work; this resolution throws `SealConfigError`
 *  synchronously (distilled-doc §Failure modes).
 *
 *  Resolution rules (locked decisions #5/#6):
 *   - `serverConfigs` override wins verbatim.
 *   - else pick the server kind: explicit `server`, else the network's
 *     `defaultServer`.
 *   - `independent` → map every standalone server to `{objectId, weight:1}`.
 *   - `committee` → a single entry `{objectId, weight:1, aggregatorUrl,
 *     …apiKey}`; throw if the committee `requiresApiKey` and none given.
 *   - mainnet has no independent → `mainnet({server:'independent'})` throws. */
export const validateLiveInputs = (inputs: LiveModeInputs): ResolvedLiveInputs => {
	const context = `seal.live: network=${String(inputs.network)}, server=${String(inputs.server)}`;

	// 1. Verbatim override.
	if (inputs.serverConfigs !== undefined) {
		const configs = inputs.serverConfigs;
		if (configs.length === 0) {
			throw sealConfigError({
				field: 'serverConfigs',
				message: `${context}: serverConfigs override must carry at least one entry.`,
			});
		}
		const first = configs[0]!;
		return {
			serverConfigs: configs,
			objectId: first.objectId,
			keyServerUrl: first.aggregatorUrl ?? '',
		};
	}

	// 2. Known-table resolution.
	const deployment = inputs.network ? KNOWN_DEPLOYMENTS[inputs.network] : null;
	if (deployment === null || deployment === undefined) {
		throw sealConfigError({
			field: 'network',
			message: `${context}: no known seal deployment. Pass a supported network ('testnet'|'mainnet') with an optional { server } selector, or supply serverConfigs explicitly.`,
		});
	}

	const kind: SealServerKind = inputs.server ?? deployment.defaultServer;

	if (kind === 'independent') {
		const servers = deployment.independent;
		if (servers === null) {
			throw sealConfigError({
				field: 'server',
				message: `${context}: no independent (standalone) key server ships for this network — use { server: 'committee' } (with an apiKey where required).`,
			});
		}
		const serverConfigs: ReadonlyArray<SealKeyServerEntry> = servers.map((s) => ({
			objectId: s.objectId,
			weight: 1,
		}));
		return {
			serverConfigs,
			objectId: servers[0]!.objectId,
			keyServerUrl: servers[0]!.url,
		};
	}

	// kind === 'committee'
	const committee = deployment.committee;
	if (committee === null) {
		throw sealConfigError({
			field: 'server',
			message: `${context}: no committee key server ships for this network.`,
		});
	}
	if (committee.requiresApiKey && (inputs.apiKey === undefined || inputs.apiKey.length === 0)) {
		throw sealConfigError({
			field: 'apiKey',
			message: `${context}: the ${committee.threshold.m}-of-${committee.threshold.n} committee requires an apiKey. Pass { apiKey, apiKeyName } (e.g. apiKey: requireValue(...) / process.env.SEAL_API_KEY).`,
		});
	}
	const apiKeyPart =
		inputs.apiKey !== undefined && inputs.apiKey.length > 0
			? {
					apiKey: inputs.apiKey,
					...(inputs.apiKeyName !== undefined ? { apiKeyName: inputs.apiKeyName } : {}),
				}
			: {};
	const serverConfigs: ReadonlyArray<SealKeyServerEntry> = [
		{
			objectId: committee.objectId,
			weight: 1,
			aggregatorUrl: committee.aggregatorUrl,
			...apiKeyPart,
		},
	];
	return {
		serverConfigs,
		objectId: committee.objectId,
		keyServerUrl: committee.aggregatorUrl,
	};
};
