import { endpointKey, type PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';

type EndpointRegisteredEvent = Extract<EngineEvent, { readonly tag: 'endpoint.registered' }>;

const SAFE_URL_FIELDS = {
	url: 'http',
	rpcUrl: 'rpc',
	faucetUrl: 'faucet',
	graphqlUrl: 'graphql',
} as const;

const SENSITIVE_URL_FIELD = /pair|token|secret|password|private|bearer/i;

export interface OperationalEndpointProjectionOptions {
	/** Routable capabilities are the authoritative public endpoint
	 * source. Resolved-value URL scraping is only a fallback for
	 * plugins with no router contribution, such as live/external
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
		if (SENSITIVE_URL_FIELD.test(field)) continue;
		const raw = record[field];
		if (typeof raw !== 'string' || !isHttpUrl(raw)) continue;
		events.push({
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey(`${pluginKey}:${field}`),
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
