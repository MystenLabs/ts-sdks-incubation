// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import forge from 'node-forge';

/** RFC 5480 id-ecPublicKey */
const ID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
/** prime256v1 / P-256 / Secp256r1 named-curve OID */
const ID_PRIME256V1 = '1.2.840.10045.3.1.7';

/**
 * Decode a PKCS#12 (`.p12`) file — typically exported from macOS Keychain
 * Access.app — and return a Sui `Secp256r1Keypair`.
 *
 * Once you have the keypair, Sui's own APIs give you everything else:
 *   - `keypair.getSecretKey()` → Bech32 `suiprivkey...` string (write into
 *     `sui.keystore` or pass to `sui keytool import`)
 *   - `keypair.getPublicKey().toSuiAddress()` → the Sui address
 *   - `keypair.signTransaction(bytes)` → signed transaction
 *
 * Pure JS, no keychain/helper dependency. Usable on any platform — a Linux CI
 * box with a `.p12` backup from a dead Mac can recover the Bech32 here.
 *
 * @example
 *   import { readFileSync } from 'node:fs';
 *   import { keypairFromP12 } from '@mysten-incubation/keyring-signer/recover';
 *
 *   const p12 = readFileSync('backup.p12');
 *   const keypair = keypairFromP12(p12, 'your-export-password');
 *   console.log(keypair.getSecretKey());        // suiprivkey1...
 *   console.log(keypair.getPublicKey().toSuiAddress());
 */
export function keypairFromP12(p12: Uint8Array, password: string): Secp256r1Keypair {
	const binary = Buffer.from(p12).toString('binary');
	let parsed: forge.pkcs12.Pkcs12Pfx;
	try {
		const asn1 = forge.asn1.fromDer(forge.util.createBuffer(binary, 'raw'));
		parsed = forge.pkcs12.pkcs12FromAsn1(asn1, password);
	} catch (err) {
		throw new Error(
			`keypairFromP12: failed to decode PKCS#12 (${(err as Error).message}). ` +
				`Check that the password is correct and the file is a valid .p12.`,
		);
	}

	const scalar = extractEcScalar(parsed);
	if (!scalar) {
		throw new Error(
			'keypairFromP12: no P-256 (Secp256r1) private key found. ' +
				'This recovery utility only supports P-256 keys as exported by macOS Keychain Access.app.',
		);
	}
	if (scalar.length !== 32) {
		throw new Error(
			`keypairFromP12: expected 32-byte P-256 scalar, got ${scalar.length}. ` +
				'The .p12 may contain a different curve or be malformed.',
		);
	}
	return Secp256r1Keypair.fromSecretKey(scalar);
}

/**
 * Walk the decrypted PKCS#12 bags and extract the 32-byte P-256 scalar from
 * the first EC private key we find. Handles both `pkcs8ShroudedKeyBag` (the
 * common case — password-encrypted) and `keyBag` (plain) shapes.
 */
function extractEcScalar(p12: forge.pkcs12.Pkcs12Pfx): Uint8Array | null {
	const bagTypes = [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag];
	for (const bagType of bagTypes) {
		const groups = p12.getBags({ bagType });
		const bags = groups[bagType];
		if (!bags) continue;
		for (const bag of bags) {
			const scalar = bagToEcScalar(bag);
			if (scalar) return scalar;
		}
	}
	return null;
}

/**
 * A PKCS#8 PrivateKeyInfo holding an EC key looks like:
 *
 *   SEQUENCE {
 *     version         INTEGER (0),
 *     algorithm       AlgorithmIdentifier { id-ecPublicKey, namedCurve OID },
 *     privateKey      OCTET STRING (contains ECPrivateKey DER)
 *   }
 *
 * The inner ECPrivateKey (RFC 5915):
 *
 *   SEQUENCE {
 *     version         INTEGER (1),
 *     privateKey      OCTET STRING (the 32-byte scalar for P-256),
 *     ...
 *   }
 *
 * We walk the ASN.1 structure by hand rather than reconstruct via OID
 * matching — forge's EC key handling doesn't populate `bag.key` for us.
 */
function bagToEcScalar(bag: forge.pkcs12.Bag): Uint8Array | null {
	const pkcs8 = bag.asn1;
	if (!pkcs8 || !isSequence(pkcs8) || pkcs8.value.length < 3) return null;

	const alg = (pkcs8.value as forge.asn1.Asn1[])[1];
	const privKeyOctet = (pkcs8.value as forge.asn1.Asn1[])[2];
	if (!alg || !privKeyOctet) return null;
	if (!isSequence(alg) || privKeyOctet.type !== forge.asn1.Type.OCTETSTRING) return null;

	const algOidNode = (alg.value as forge.asn1.Asn1[])[0];
	if (!algOidNode || algOidNode.type !== forge.asn1.Type.OID) return null;
	const algOid = forge.asn1.derToOid(algOidNode.value as string);
	// id-ecPublicKey (RFC 5480 §2.1.1). node-forge doesn't ship a named constant.
	if (algOid !== ID_EC_PUBLIC_KEY) return null;

	// Validate the named curve is P-256 (Sui Secp256r1). Reject other curves.
	const curveOidNode = (alg.value as forge.asn1.Asn1[])[1];
	if (curveOidNode && curveOidNode.type === forge.asn1.Type.OID) {
		const curveOid = forge.asn1.derToOid(curveOidNode.value as string);
		if (curveOid !== ID_PRIME256V1) return null;
	}

	const ecPrivKeyDer = privKeyOctet.value as string;
	const ecPrivKeyAsn1 = forge.asn1.fromDer(ecPrivKeyDer);
	if (!isSequence(ecPrivKeyAsn1) || ecPrivKeyAsn1.value.length < 2) return null;

	const scalarOctet = (ecPrivKeyAsn1.value as forge.asn1.Asn1[])[1];
	if (!scalarOctet || scalarOctet.type !== forge.asn1.Type.OCTETSTRING) return null;

	return new Uint8Array(Buffer.from(scalarOctet.value as string, 'binary'));
}

function isSequence(node: forge.asn1.Asn1): node is forge.asn1.Asn1 & { value: forge.asn1.Asn1[] } {
	return node.type === forge.asn1.Type.SEQUENCE && Array.isArray(node.value);
}
