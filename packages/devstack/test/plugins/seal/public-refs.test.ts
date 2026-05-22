import { describe, expect, it } from 'vitest';

import { account } from '../../../src/plugins/account/index.ts';
import * as SealPublic from '../../../src/plugins/seal/index.ts';
import {
	seal,
	sealFor,
	sealResourceId,
	type SealResolved,
} from '../../../src/plugins/seal/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';

describe('seal public refs', () => {
	it('local-keygen signer is a direct account member ref threaded through dependencies', () => {
		const publisher = account('publisher');
		const plugin = seal({ mode: 'local-keygen', signer: publisher });

		expect(plugin.id).toBe('seal:seal');
		expect(plugin.dependsOn.map((resource) => resource.id)).toEqual(['sui', 'account/publisher']);
	});

	it('mode-narrowed localKeygen keeps the direct signer ref shape', () => {
		const signer = account('operator');
		const plugin = sealFor({ mode: 'local', chain: chainId('sui:localnet') } as const).localKeygen({
			name: 'private-content',
			signer,
		});

		expect(plugin.id).toBe('seal:private-content');
		expect(plugin.dependsOn.map((resource) => resource.id)).toEqual(['sui', 'account/operator']);
	});

	it('the direct seal member resolves to key-server fields plus a manager slot', () => {
		const signer = account('manager');
		const plugin = seal({ mode: 'local-keygen', signer });

		const resolved: SealResolved = {
			mode: 'local-keygen',
			objectId: '0x1',
			keyServerUrl: 'http://key-server.localhost',
			serverConfigs: [{ objectId: '0x1', weight: 1 }],
			manager: {
				masterKeyEnvFile: '/tmp/master-key.env',
				rotate: undefined as never,
			},
		};

		expect(plugin.id).toBe(sealResourceId('seal'));
		expect(resolved.keyServerUrl).toBe('http://key-server.localhost');
		expect(resolved.manager?.masterKeyEnvFile).toBe('/tmp/master-key.env');
	});

	it('does not export an unsupported manager resource constructor from the plugin barrel', () => {
		expect('makeSealManagerTag' in SealPublic).toBe(false);
		expect('sealManagerTagId' in SealPublic).toBe(false);
	});
});
