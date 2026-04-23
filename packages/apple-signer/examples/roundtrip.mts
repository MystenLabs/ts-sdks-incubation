// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end roundtrip against the real native helper + macOS.
 *
 * Run with: pnpm --filter @mysten-incubation/apple-signer roundtrip
 *
 * Covers:
 *   • Enclave mode — SE-backed, biometric, non-recoverable
 *   • Keychain-random — helper generates P-256 in keychain (no bytes in Node)
 *   • Keychain-imported (Bech32) — brings bytes into Node briefly then imports
 *   • Keychain-imported (mnemonic) — same, via BIP39 derivation
 *   • Keychain generate-mnemonic — helper-driven + display mnemonic once
 *
 * Flags:
 *   --run=enclave,keychain  (default: enclave,keychain)
 *
 * Keychain mode requires Developer-ID signing for persistent keychain access.
 * On ad-hoc signed builds, keychain ops throw errSecMissingEntitlement (-34018).
 * The script catches this and reports the mode as "skipped (Developer ID required)".
 */

import { parseSerializedSignature } from '@mysten/sui/cryptography';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { Secp256r1PublicKey } from '@mysten/sui/keypairs/secp256r1';

import {
	SubprocessHelper,
	createEnclaveSigner,
	createKeychainSigner,
	deleteEnclaveSigner,
	deleteKeychainSigner,
	listEnclaveSigners,
	listKeychainSigners,
	loadKeychainSigner,
} from '../src/index.js';

const color = {
	gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let totalFailed = 0;
let totalSkipped = 0;

function parseModes(): Set<string> {
	const flag = process.argv.find((a) => a.startsWith('--run='));
	if (!flag) return new Set(['enclave', 'keychain']);
	return new Set(
		flag
			.slice('--run='.length)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

function check(name: string, ok: boolean, detail?: string) {
	const mark = ok ? color.green('✓') : color.red('✗');
	const d = detail ? color.gray(` — ${detail}`) : '';
	console.log(`  ${mark} ${name}${d}`);
	if (!ok) totalFailed++;
}

function isDeveloperIdRequired(err: unknown): boolean {
	const msg = (err as Error).message ?? '';
	return /errSecMissingEntitlement|-34018|Developer ID/i.test(msg);
}

async function runEnclave(helper: SubprocessHelper, runLabel: string) {
	const tag = `apple-signer-rt-enclave-${runLabel}`;
	console.log(color.bold(color.cyan('\n── Enclave mode ──')));
	try {
		const signer = await createEnclaveSigner({ tag, helper });
		const address = signer.getPublicKey().toSuiAddress();
		console.log(color.gray(`  address: ${address}`));

		console.log(color.bold('  First sign (EXPECT Touch ID PROMPT)'));
		const msg1 = new TextEncoder().encode('first-message');
		const sig1 = await signer.signPersonalMessage(msg1);
		check(
			'  signPersonalMessage + verify',
			await signer.getPublicKey().verifyPersonalMessage(msg1, sig1.signature),
		);

		console.log(color.bold('  Subsequent signs (should be silent)'));
		for (let i = 0; i < 3; i++) {
			const msg = new TextEncoder().encode(`subsequent-${i}`);
			const sig = await signer.signPersonalMessage(msg);
			check(
				`  sign #${i + 2} verifies`,
				await signer.getPublicKey().verifyPersonalMessage(msg, sig.signature),
			);
		}

		const txBytes = new TextEncoder().encode('tx-payload');
		const txSig = await signer.signTransaction(txBytes);
		check(
			'  signTransaction + verify',
			await signer.getPublicKey().verifyTransaction(txBytes, txSig.signature),
		);

		const parsed = parseSerializedSignature(txSig.signature);
		if (!parsed.publicKey) throw new Error('parsed.publicKey missing');
		const pub = new Secp256r1PublicKey(parsed.publicKey);
		check(
			'  pubkey embedded in signature derives to same address',
			pub.toSuiAddress() === address,
		);
		check('  scheme flag is Secp256r1', parsed.signatureScheme === 'Secp256r1');

		const tags = await listEnclaveSigners({ helper });
		check('  list includes our tag', tags.includes(tag));
		check('  delete returns true', (await deleteEnclaveSigner({ tag, helper })) === true);
		check('  second delete returns false', (await deleteEnclaveSigner({ tag, helper })) === false);
	} finally {
		await deleteEnclaveSigner({ tag, helper }).catch(() => {});
	}
}

async function runKeychain(helper: SubprocessHelper, runLabel: string) {
	const suffix = `apple-signer-rt-keychain-${runLabel}`;
	console.log(color.bold(color.cyan('\n── Keychain mode ──')));

	// Probe first — if keychain.generate hits -34018, skip this whole mode.
	try {
		await createKeychainSigner({
			tag: `${suffix}-probe`,
			requireBiometric: false,
			helper,
		});
		await deleteKeychainSigner({ tag: `${suffix}-probe`, helper }).catch(() => {});
	} catch (err) {
		if (isDeveloperIdRequired(err)) {
			console.log(
				color.yellow(
					'  skipped: keychain mode requires Developer-ID signing (ad-hoc builds hit -34018).\n' +
						'  This is expected for local dev; fix in CI when the signing pipeline is set up.',
				),
			);
			totalSkipped++;
			return;
		}
		throw err;
	}

	// 1. Random
	await keychainFlow(
		helper,
		`${suffix}-random`,
		'keychain-random',
		{ source: 'random' },
		undefined,
	);

	// 2. Bech32 import
	const byoBech32 = new Secp256r1Keypair();
	await keychainFlow(
		helper,
		`${suffix}-bech32`,
		'keychain-imported (bech32)',
		{ source: 'bech32', bech32: byoBech32.getSecretKey() },
		byoBech32.getPublicKey().toSuiAddress(),
	);

	// 3. Mnemonic import
	const { generateMnemonic } = await import('@scure/bip39');
	const { wordlist } = await import('@scure/bip39/wordlists/english.js');
	const mnemonic = generateMnemonic(wordlist, 256);
	const byoMnemonic = Secp256r1Keypair.deriveKeypair(mnemonic);
	await keychainFlow(
		helper,
		`${suffix}-mnemonic`,
		'keychain-imported (mnemonic)',
		{ source: 'mnemonic', mnemonic },
		byoMnemonic.getPublicKey().toSuiAddress(),
	);

	// 4. Generate-mnemonic
	console.log(color.bold(`\n  • keychain generate-mnemonic (${suffix}-generated)`));
	try {
		const { signer, mnemonic: generatedMnemonic } = await createKeychainSigner({
			tag: `${suffix}-generated`,
			helper,
			requireBiometric: false,
			seed: { source: 'generate-mnemonic', wordCount: 24 },
		});
		check('    mnemonic is returned', typeof generatedMnemonic === 'string');
		check('    mnemonic is 24 words', generatedMnemonic!.split(/\s+/).length === 24);
		const derived = Secp256r1Keypair.deriveKeypair(generatedMnemonic!);
		check(
			'    mnemonic reproduces the signer address',
			derived.getPublicKey().toSuiAddress() === signer.getPublicKey().toSuiAddress(),
		);
		const reloaded = await loadKeychainSigner({ tag: `${suffix}-generated`, helper });
		check(
			'    reload from keychain matches the address',
			reloaded?.getPublicKey().toSuiAddress() === signer.getPublicKey().toSuiAddress(),
		);
	} finally {
		await deleteKeychainSigner({ tag: `${suffix}-generated`, helper }).catch(() => {});
	}

	// List all tags
	const allTags = await listKeychainSigners({ helper });
	check(
		'  list returns no leftover tags from this run',
		!allTags.some((t) => t.startsWith(suffix)),
		allTags.length ? `remaining: ${allTags.join(',')}` : undefined,
	);
}

async function keychainFlow(
	helper: SubprocessHelper,
	tag: string,
	label: string,
	seed: Parameters<typeof createKeychainSigner>[0]['seed'],
	expectedAddress: string | undefined,
) {
	console.log(color.bold(`\n  • ${label} (${tag})`));
	try {
		const { signer } = await createKeychainSigner({
			tag,
			helper,
			requireBiometric: false, // keep roundtrip silent for keychain mode
			seed,
		});
		const address = signer.getPublicKey().toSuiAddress();
		console.log(color.gray(`    address: ${address}`));

		if (expectedAddress) {
			check('    imported key reproduces input address', address === expectedAddress);
		}

		const msg = new TextEncoder().encode(`hi ${label}`);
		const sig = await signer.signPersonalMessage(msg);
		check(
			'    signPersonalMessage + verify',
			await signer.getPublicKey().verifyPersonalMessage(msg, sig.signature),
		);

		const txBytes = new TextEncoder().encode(`tx ${label}`);
		const txSig = await signer.signTransaction(txBytes);
		check(
			'    signTransaction + verify',
			await signer.getPublicKey().verifyTransaction(txBytes, txSig.signature),
		);

		const reloaded = await loadKeychainSigner({ tag, helper });
		check('    reload yields same address', reloaded?.getPublicKey().toSuiAddress() === address);
	} finally {
		await deleteKeychainSigner({ tag, helper }).catch(() => {});
	}
}

async function main() {
	const runLabel = String(Date.now());
	const modes = parseModes();
	console.log(color.bold('\napple-signer roundtrip'));
	console.log(color.gray(`Modes: ${[...modes].join(', ')}   tag suffix: ${runLabel}`));

	const helper = await SubprocessHelper.load();
	try {
		if (modes.has('enclave')) await runEnclave(helper, runLabel);
		if (modes.has('keychain')) await runKeychain(helper, runLabel);
	} finally {
		await helper.close();
	}

	if (totalFailed > 0) {
		console.log(color.red(`\n${totalFailed} check(s) failed`));
		process.exit(1);
	}
	if (totalSkipped > 0) {
		console.log(color.yellow(`\n${totalSkipped} mode(s) skipped`));
	}
	console.log(color.green('\nall run checks passed'));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
