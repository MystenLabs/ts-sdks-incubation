import { describe, expect, it } from 'vitest';

import {
	parseMasterKeyEnvFile,
	parseSealKeyServerConfig,
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

	it('parses the persisted key-server ids needed for warm restart', () => {
		const body = renderSealKeyServerConfig({
			sealPackageId: '0x7',
			nodeUrl: 'http://sui:9000',
			keyServerObjectId: '0xabc123',
		});

		expect(parseSealKeyServerConfig(body)).toEqual({
			sealPackageId: '0x7',
			nodeUrl: 'http://sui:9000',
			keyServerObjectId: '0xabc123',
		});
	});

	it('ignores commented-out fields when parsing (defensive against future comment emission)', () => {
		// Regression: the field reader must not pick up a commented
		// `# node_url: "fake"` line when a real `node_url:` field is
		// present later in the body. Anchoring on inline-whitespace
		// only (not `\s` which crosses newlines) keeps the start-of-line
		// guard strict.
		const body = [
			'network: !Devnet',
			'  seal_package: "0x7"',
			'# node_url: "http://attacker:9999"',
			'node_url: "http://sui:9000"',
			'server_mode: !Open',
			'  key_server_object_id: "0xabc123"',
			'',
		].join('\n');

		expect(parseSealKeyServerConfig(body)).toEqual({
			sealPackageId: '0x7',
			nodeUrl: 'http://sui:9000',
			keyServerObjectId: '0xabc123',
		});
	});

	it('returns null when every occurrence of a field is commented out', () => {
		const body = [
			'network: !Devnet',
			'  seal_package: "0x7"',
			'# node_url: "http://attacker:9999"',
			'server_mode: !Open',
			'  key_server_object_id: "0xabc123"',
			'',
		].join('\n');

		expect(parseSealKeyServerConfig(body)).toBeNull();
	});
});

describe('renderMasterKeyEnvFile', () => {
	it('renders the single env-file line consumed by the entrypoint wrapper', () => {
		expect(renderMasterKeyEnvFile('0x1234')).toBe('MASTER_KEY=0x1234\n');
	});

	it('parses the persisted master key without the optional hex prefix', () => {
		expect(parseMasterKeyEnvFile('MASTER_KEY=0x1234\n')).toBe('1234');
		expect(parseMasterKeyEnvFile('MASTER_KEY=abcd\n')).toBe('abcd');
		expect(parseMasterKeyEnvFile('TOKEN=abcd\n')).toBeNull();
	});
});
