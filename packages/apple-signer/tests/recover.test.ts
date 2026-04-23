// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

import { keypairFromP12 } from '../src/recover.js';

// Fixture generated with:
//   openssl ecparam -genkey -name prime256v1 -noout -out rec-test.pem
//   openssl pkcs12 -export -inkey rec-test.pem -out rec-test.p12 \
//     -passout pass:testpass -name "rec-test" -nocerts -legacy
// Scalar recovered via: openssl ec -in rec-test.pem -text -noout
const FIXTURE_P12_BASE64 =
	'MIIBWgIBAzCCARgGCSqGSIb3DQEHAaCCAQkEggEFMIIBATCB/gYJKoZIhvcNAQcBoIHwBIHt' +
	'MIHqMIHnBgsqhkiG9w0BDAoBAqCBtDCBsTAcBgoqhkiG9w0BDAEDMA4ECD0N3TorXs8gAgII' +
	'AASBkFDZ/DKihUYKZfVO8gD1hwa4nW68W18vWGrDVgHUyG23f9diwfbXHEG7tZx6V2XFxtly' +
	'l9OCKCNTownQZPcpyulKPxEuyE+Ogi2uNj6oDLwdyG/1JstaHPKHrkmrA+nM4MB5T3aynUIk' +
	'4bnQN4JWta6AqqMHf5fqoNdNtyuFkBR8iKJOEq01VJ1xZKikNwl42DEhMB8GCSqGSIb3DQEJ' +
	'FDESHhAAcgBlAGMALQB0AGUAcwB0MDkwITAJBgUrDgMCGgUABBQ9jdFiaXPmJzqGkmdWiUmv' +
	'csN18AQQSkuLmiJ35OVjRPZTaVEp6QICCAA=';
const FIXTURE_PASSWORD = 'testpass';
const FIXTURE_SCALAR_HEX = '9567e326ba175e6016cdcf11019f76c3a272cb75eb4547e6cac7718da61c2ee6';

describe('keypairFromP12', () => {
	it('recovers a Secp256r1Keypair matching the fixture scalar', () => {
		const p12 = Uint8Array.from(Buffer.from(FIXTURE_P12_BASE64, 'base64'));
		const keypair = keypairFromP12(p12, FIXTURE_PASSWORD);

		expect(keypair.getKeyScheme()).toBe('Secp256r1');

		const bech32 = keypair.getSecretKey();
		const { scheme, secretKey } = decodeSuiPrivateKey(bech32);
		expect(scheme).toBe('Secp256r1');
		expect(Buffer.from(secretKey).toString('hex')).toBe(FIXTURE_SCALAR_HEX);
	});

	it('returned keypair can sign and verify via Sui', async () => {
		const p12 = Uint8Array.from(Buffer.from(FIXTURE_P12_BASE64, 'base64'));
		const keypair = keypairFromP12(p12, FIXTURE_PASSWORD);
		const msg = new TextEncoder().encode('hello p12');

		const { signature } = await keypair.signPersonalMessage(msg);
		expect(await keypair.getPublicKey().verifyPersonalMessage(msg, signature)).toBe(true);
	});

	it('throws on wrong password', () => {
		const p12 = Uint8Array.from(Buffer.from(FIXTURE_P12_BASE64, 'base64'));
		expect(() => keypairFromP12(p12, 'wrong-password')).toThrow(/PKCS#12|password/i);
	});

	it('throws on malformed input', () => {
		expect(() => keypairFromP12(new Uint8Array([0, 1, 2, 3]), 'x')).toThrow(/PKCS#12/);
	});
});
