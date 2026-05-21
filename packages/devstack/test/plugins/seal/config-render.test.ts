import { describe, expect, it } from 'vitest';

import {
	renderMasterKeyEnvFile,
	renderSealKeyServerConfig,
} from '../../../src/plugins/seal/config-render.ts';

describe('renderSealKeyServerConfig', () => {
	it('renders the nested shape parsed by seal key-server v0.6.6', () => {
		expect(
			renderSealKeyServerConfig({
				sealPackageId: '0x7',
				nodeUrl: 'http://host.docker.internal:9000',
				keyServerObjectId: '0xabc123',
			}),
		).toBe(
			[
				'network: !Devnet',
				'  seal_package: "0x7"',
				'node_url: "http://host.docker.internal:9000"',
				'server_mode: !Open',
				'  key_server_object_id: "0xabc123"',
				'ts_sdk_version_requirement: ">=0.4.5"',
				'',
			].join('\n'),
		);
	});

	it('preserves caller-supplied TypeScript SDK version requirements', () => {
		expect(
			renderSealKeyServerConfig({
				sealPackageId: '0x7',
				nodeUrl: 'http://host.docker.internal:9000',
				keyServerObjectId: '0xabc123',
				tsSdkVersionRequirement: '>=0.6.0',
			}),
		).toContain('ts_sdk_version_requirement: ">=0.6.0"');
	});
});

describe('renderMasterKeyEnvFile', () => {
	it('renders the single env-file line consumed by the entrypoint wrapper', () => {
		expect(renderMasterKeyEnvFile('0x1234')).toBe('MASTER_KEY=0x1234\n');
	});
});
