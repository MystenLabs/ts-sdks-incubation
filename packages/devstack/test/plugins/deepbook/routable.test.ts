// Unit tests for the deepbook Routable contribution. Substrate
// router is name-blind — pin the dispatch-id shape so the router
// hostname mint stays deterministic.

import { describe, expect, it } from 'vitest';

import {
	buildServerDispatchId,
	DEEPBOOK_SERVER_ENDPOINT_NAME,
	makeServerRoutable,
} from '../../../src/plugins/deepbook/routable.ts';

describe('buildServerDispatchId', () => {
	it('folds the instance name into the service key', () => {
		expect(buildServerDispatchId('main')).toEqual({
			serviceKey: 'deepbook:main',
			role: 'server',
		});
	});
});

describe('makeServerRoutable', () => {
	it('emits an HTTP routable with CORS enabled', () => {
		const decl = makeServerRoutable({
			name: 'main',
			containerName: 'devstack-app-main-deepbook-main-server',
		});
		expect(decl.kind).toBe('routable');
		expect(decl.endpointName).toBe(DEEPBOOK_SERVER_ENDPOINT_NAME);
		expect(decl.wireProtocol === undefined || decl.wireProtocol === 'http').toBe(true);
		if (decl.wireProtocol !== 'tcp') {
			expect(decl.cors).toBe(true);
		}
		expect(decl.upstream).toEqual({
			type: 'container',
			containerName: 'devstack-app-main-deepbook-main-server',
			containerPort: 9008,
		});
	});
});
