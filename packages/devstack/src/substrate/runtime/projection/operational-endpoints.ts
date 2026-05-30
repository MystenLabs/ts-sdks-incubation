import { endpointKey, type PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';

type EndpointRegisteredEvent = Extract<EngineEvent, { readonly tag: 'endpoint.registered' }>;

// Endpoint-projection policy is closed-allowlist:
// only the fields enumerated below are projected as operational
// endpoints. Anything else — including legitimate sensitive URLs
// (`pairUrl`, `walletPairingToken`, OAuth `tokenUrl`, etc.) and any
// future field a plugin adds — is ignored by default. A plugin that
// wants a new field projected must extend this list AND ship a
// projection test pinning its display name. The previous loose
// "skip-if-matches-sensitive-regex" check dropped legitimate OAuth
// fields like `tokenUrl` and missed novel sensitive names; the
// allowlist removes that whole class of false-negative/false-positive
// pair.
const SAFE_URL_FIELDS = {
	url: 'http',
	rpcUrl: 'rpc',
	faucetUrl: 'faucet',
	graphqlUrl: 'graphql',
} as const;

export interface OperationalEndpointProjectionOptions {
	/** Routable capabilities are the authoritative public endpoint
	 * source. Resolved-value URL scraping is only a fallback for
	 * plugins with no router contribution, such as live/local-rpc
	 * network modes. */
	readonly routablesPresent?: boolean;
}

export const operationalEndpointEventsFromResolvedValue = (
	pluginKey: PluginKey,
	value: unknown,
	registeredAt: number,
	options: OperationalEndpointProjectionOptions = {},
): ReadonlyArray<EndpointRegisteredEvent> => {
	if (options.routablesPresent === true) return [];
	if (value === null || typeof value !== 'object') return [];
	const record = value as Readonly<Record<string, unknown>>;
	const events: Array<EndpointRegisteredEvent> = [];
	for (const [field, name] of Object.entries(SAFE_URL_FIELDS)) {
		const raw = record[field];
		if (typeof raw !== 'string' || !isHttpUrl(raw)) continue;
		events.push({
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey(`${pluginKey}:${field}`),
				pluginKey,
				name,
				url: raw,
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt,
			},
		});
	}
	return events;
};

const isHttpUrl = (value: string): boolean => {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
};
