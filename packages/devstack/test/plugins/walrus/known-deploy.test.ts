import { describe, expect, it } from 'vitest';

import { resolveKnownDeploymentOptions } from '../../../src/plugins/walrus/mode/known-deploy.ts';

const NODE = {
	nodeIndex: 0,
	nodeId: '0x1',
	publicHostname: 'node.example',
	rpcUrl: 'https://node.example:9185',
};

const REQUIRED = {
	systemObjectId: '0xaaaa',
	stakingPoolId: '0xbbbb',
	nodes: [NODE],
};

describe('walrus known deployment options', () => {
	it('does not treat a publisher URL as the read/proxy URL', () => {
		const resolved = resolveKnownDeploymentOptions({
			...REQUIRED,
			publisherUrl: 'https://publisher.example',
		});

		expect(resolved.publisherUrl).toBe('https://publisher.example');
		expect(resolved.aggregatorUrl).toBeNull();
		expect(resolved.proxyUrl).toBeNull();
	});

	it('uses the aggregator URL as the read/proxy fallback', () => {
		const resolved = resolveKnownDeploymentOptions({
			...REQUIRED,
			aggregatorUrl: 'https://aggregator.example',
			publisherUrl: 'https://publisher.example',
		});

		expect(resolved.publisherUrl).toBe('https://publisher.example');
		expect(resolved.aggregatorUrl).toBe('https://aggregator.example');
		expect(resolved.proxyUrl).toBe('https://aggregator.example');
	});
});
