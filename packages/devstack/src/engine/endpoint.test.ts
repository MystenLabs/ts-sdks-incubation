// Pinning the `endpointUrl` discriminator. The three modes (`'host'`,
// `'container'`, `'auto'`) drive every consumer's choice between the
// routed host URL and the docker-DNS container URL — getting any of
// them wrong silently breaks either browser-side resolution (when a
// container URL leaks to the host) or in-container DNS (when the host
// URL leaks to a glibc container that hardcodes `.localhost`).

import { describe, expect, it } from 'vitest';
import { endpointUrl, type Endpoint } from './endpoint.js';

describe('endpointUrl', () => {
	const withBoth: Endpoint = {
		host: 'http://sui.app.localhost:9000',
		container: 'http://sui-localnet:9000',
		containerNetworks: ['app-sui-network'],
	};
	const hostOnly: Endpoint = { host: 'https://fullnode.testnet.sui.io:443' };

	it("'host' returns the host URL", () => {
		expect(endpointUrl(withBoth, 'host')).toBe('http://sui.app.localhost:9000');
		expect(endpointUrl(hostOnly, 'host')).toBe('https://fullnode.testnet.sui.io:443');
	});

	it("'container' returns the container URL when defined", () => {
		expect(endpointUrl(withBoth, 'container')).toBe('http://sui-localnet:9000');
	});

	it("'container' on a host-only endpoint throws", () => {
		// Live-net handles have no docker-side address; callers asking
		// for `'container'` on those must check `e.container` first.
		expect(() => endpointUrl(hostOnly, 'container')).toThrow(/no container-side URL/);
	});

	it("'auto' prefers container when defined, falls back to host otherwise", () => {
		expect(endpointUrl(withBoth, 'auto')).toBe('http://sui-localnet:9000');
		expect(endpointUrl(hostOnly, 'auto')).toBe('https://fullnode.testnet.sui.io:443');
	});
});
