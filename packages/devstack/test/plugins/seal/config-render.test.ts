import { describe, expect, it } from 'vitest';

import {
	parseMasterKeyEnvFile,
	parseSealKeyServerConfig,
	renderMasterKeyEnvFile,
	renderSealKeyServerConfig,
	type SealKeyServerConfigInputs,
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

	// --- assertYamlSafe: the load-bearing YAML-injection guard --------------
	//
	// The renderer interpolates object ids / node URLs into double-quoted
	// YAML. assertYamlSafe() is the whitelist that prevents a `"` (or
	// newline, or `${}`) from closing the quote and injecting YAML syntax.
	// These cases drive the REAL renderSealKeyServerConfig refusal — they
	// fail if the regex anchors (`^…$`) are dropped or the guard is removed.
	const HAPPY: SealKeyServerConfigInputs = {
		sealPackageId: '0x7',
		nodeUrl: 'http://sui:9000',
		keyServerObjectId: '0xabc123',
	};

	/** Pull the typed SealConfigError out of the sync throw so we can
	 *  assert `_tag` + the offending `field`, not just `toThrow()`. */
	const renderError = (inputs: SealKeyServerConfigInputs): unknown => {
		try {
			renderSealKeyServerConfig(inputs);
		} catch (caught) {
			return caught;
		}
		throw new Error('expected renderSealKeyServerConfig to throw, but it returned');
	};

	it.each([
		['nodeUrl', { ...HAPPY, nodeUrl: 'http://sui:9000" injected: true #' }],
		['keyServerObjectId', { ...HAPPY, keyServerObjectId: '0xabc"\ninjected: true' }],
		['sealPackageId', { ...HAPPY, sealPackageId: '0x7${env}' }],
	] as ReadonlyArray<[string, SealKeyServerConfigInputs]>)(
		'refuses a %s carrying a quote/newline/${} with a typed SealConfigError naming the field',
		(field, inputs) => {
			const err = renderError(inputs) as { _tag?: unknown; field?: unknown };
			expect(err._tag).toBe('SealConfigError');
			expect(err.field).toBe(field);
		},
	);

	it('refuses a newline embedded in an otherwise-safe field (multi-line injection)', () => {
		// A bare `\n` would let the interpolated value escape its quoted
		// line entirely; the single-line whitelist must reject it.
		const err = renderError({ ...HAPPY, nodeUrl: 'http://sui:9000\nmalicious: 1' }) as {
			_tag?: unknown;
			field?: unknown;
		};
		expect(err._tag).toBe('SealConfigError');
		expect(err.field).toBe('nodeUrl');
	});

	it('accepts a SemVer comparator in ts_sdk_version_requirement but rejects an injection there', () => {
		// The SemVer field has a WIDER whitelist (`<>=^~* |`) so `>=0.4.5`
		// renders, but a `"`/`${}` must still be refused — assert both arms
		// so a future widening of the SemVer regex can't open an injection.
		expect(renderSealKeyServerConfig({ ...HAPPY, tsSdkVersionRequirement: '>=0.4.5' })).toContain(
			'ts_sdk_version_requirement: ">=0.4.5"',
		);

		const err = renderError({
			...HAPPY,
			tsSdkVersionRequirement: '>=0.4.5" rogue: true',
		}) as { _tag?: unknown; field?: unknown };
		expect(err._tag).toBe('SealConfigError');
		expect(err.field).toBe('tsSdkVersionRequirement');
	});

	it('renders the happy-path control unchanged (guard does not over-reject valid ids/URLs)', () => {
		// Control: the exact characters a real Sui object id / node URL use
		// (`0x`, `:/_.-`, digits, letters) must pass the whitelist.
		expect(() => renderSealKeyServerConfig(HAPPY)).not.toThrow();
		expect(renderSealKeyServerConfig(HAPPY)).toContain('node_url: "http://sui:9000"');
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
