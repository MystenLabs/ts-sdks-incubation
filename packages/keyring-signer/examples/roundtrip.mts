// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive end-to-end roundtrip for every keyring-signer backend.
 *
 * Run with:  pnpm --filter @mysten-incubation/keyring-signer roundtrip
 *
 * For each backend the user selects, this script:
 *   1. Creates a signer for a unique (service, account) pair
 *   2. Signs a transaction and a personal message
 *   3. Verifies both signatures against the signer's public key
 *   4. Parses the serialized signature, extracts the embedded public key,
 *      and confirms the address derived from it matches the signer's address
 *   5. Reloads the signer from the backend and confirms addresses match
 *   6. Deletes the entry and confirms it's gone
 *
 * Tested for both ED25519 and Secp256r1 schemes.
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type { Signer, SignatureScheme } from '@mysten/sui/cryptography';
import { parseSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Secp256r1PublicKey } from '@mysten/sui/keypairs/secp256r1';

import type { KeyringBackend, SupportedScheme } from '../src/index.js';
import {
	EnvBackend,
	MemoryKeyringBackend,
	NapiKeyringBackend,
	createKeyringSigner,
	exportKeyringSignerSecret,
	loadKeyringSigner,
} from '../src/index.js';

const rl = readline.createInterface({ input, output });
const color = {
	gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

type Check = { name: string; ok: boolean; detail?: string };

const SCHEMES: SupportedScheme[] = ['ED25519', 'Secp256r1'];

async function main() {
	const label = new Date().toISOString().replace(/[:.]/g, '-');
	const service = `keyring-signer-roundtrip-${label}`;

	console.log(color.bold('\nkeyring-signer interactive roundtrip'));
	console.log(color.gray(`Using scratch service name "${service}" for this run.\n`));

	const pickers: Record<string, { label: string; choose: () => Promise<void> }> = {
		memory: { label: 'Memory (always safe)', choose: () => testMemory(service) },
		env: { label: 'Env (reads process.env; no side effects)', choose: () => testEnv(service) },
		napi: { label: 'OS keyring (@napi-rs/keyring)', choose: () => testNapi(service) },
	};
	const pickerList = Object.entries(pickers);

	// Batch mode: --run=memory,env,napi
	const runArg = process.argv.find((a) => a.startsWith('--run='));
	if (runArg) {
		const names = runArg
			.slice('--run='.length)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		for (const name of names) {
			const picker = pickers[name];
			if (!picker) {
				console.log(color.red(`unknown backend "${name}"`));
				continue;
			}
			await safely(picker.label, picker.choose);
		}
		rl.close();
		return;
	}

	while (true) {
		console.log(color.bold('Pick a backend to test:'));
		pickerList.forEach(([key, p], i) =>
			console.log(`  ${i + 1}. ${p.label}  ${color.gray(`(--run=${key})`)}`),
		);
		console.log('  a. Run all');
		console.log('  q. Quit\n');

		let answer: string;
		try {
			answer = (await rl.question('> ')).trim().toLowerCase();
		} catch {
			break; // stdin closed (piped input ran out)
		}
		if (answer === 'q' || answer === '') break;

		if (answer === 'a') {
			for (const [, p] of pickerList) await safely(p.label, p.choose);
			continue;
		}

		const idx = Number.parseInt(answer, 10);
		const entry = pickerList[idx - 1];
		if (!entry) {
			console.log(color.red('unknown choice\n'));
			continue;
		}
		await safely(entry[1].label, entry[1].choose);
	}

	rl.close();
}

async function safely(label: string, fn: () => Promise<void>) {
	console.log(color.bold(color.cyan(`\n── ${label} ──`)));
	try {
		await fn();
	} catch (err) {
		console.log(color.red(`  ✗ ${(err as Error).message}`));
	}
	console.log('');
}

// ---------- backend test runners ----------

async function testMemory(service: string) {
	const backend = new MemoryKeyringBackend();
	for (const scheme of SCHEMES) {
		await runRoundtrip(`Memory / ${scheme}`, backend, scheme, service, 'publisher');
	}
}

async function testEnv(service: string) {
	// EnvBackend is read-only, so we pre-seed a key via Memory + Env var
	for (const scheme of SCHEMES) {
		const seed = new MemoryKeyringBackend();
		await createKeyringSigner({ scheme, account: 'publisher', service, backend: seed });
		const bech32 = (await exportKeyringSignerSecret({
			account: 'publisher',
			service,
			backend: seed,
		}))!;

		const varName = `SUI_KEYRING_SIGNER_${sanitize(service)}_PUBLISHER`;
		const env = { [varName]: bech32 };
		const backend = new EnvBackend({ env });

		await runReadOnlyRoundtrip(`Env / ${scheme}`, backend, service, 'publisher');
	}
}

async function testNapi(service: string) {
	const backend = await NapiKeyringBackend.load();
	try {
		for (const scheme of SCHEMES) {
			await runRoundtrip(`Napi / ${scheme}`, backend, scheme, service, 'publisher');
		}
	} finally {
		await backend.delete(service, 'publisher').catch(() => {});
	}
}

// ---------- core roundtrip logic ----------

async function runRoundtrip(
	label: string,
	backend: KeyringBackend,
	scheme: SupportedScheme,
	service: string,
	account: string,
) {
	console.log(color.bold(`\n  • ${label}`));

	// Ensure clean slate
	await backend.delete(service, account).catch(() => {});

	const signer = await createKeyringSigner({ scheme, account, service, backend });
	const address = signer.getPublicKey().toSuiAddress();
	console.log(color.gray(`    address: ${address}`));

	const checks = await runChecks(signer, scheme, backend, service, account);

	// Cleanup
	const deleted = await backend.delete(service, account);
	checks.push({
		name: 'delete() reports true',
		ok: deleted === true,
		detail: `returned ${deleted}`,
	});
	const afterDelete = await backend.get(service, account);
	checks.push({
		name: 'entry is gone after delete',
		ok: afterDelete === null,
		detail: afterDelete === null ? undefined : 'still present',
	});

	report(checks);
}

async function runReadOnlyRoundtrip(
	label: string,
	backend: KeyringBackend,
	service: string,
	account: string,
) {
	console.log(color.bold(`\n  • ${label}`));

	const signer = await loadKeyringSigner({ account, service, backend });
	if (!signer) {
		console.log(color.red('    load returned null'));
		return;
	}
	const address = signer.getPublicKey().toSuiAddress();
	console.log(color.gray(`    address: ${address}`));

	const checks = await runChecks(
		signer,
		signer.getKeyScheme() as SupportedScheme,
		backend,
		service,
		account,
		{
			readOnly: true,
		},
	);
	report(checks);
}

async function runChecks(
	signer: Signer,
	scheme: SupportedScheme,
	backend: KeyringBackend,
	service: string,
	account: string,
	{ readOnly = false }: { readOnly?: boolean } = {},
): Promise<Check[]> {
	const checks: Check[] = [];
	const address = signer.getPublicKey().toSuiAddress();

	// 1. Transaction signature verifies
	const txBytes = new TextEncoder().encode(`sui-tx-${Math.random()}`);
	const txSig = await signer.signTransaction(txBytes);
	const txOk = await signer.getPublicKey().verifyTransaction(txBytes, txSig.signature);
	checks.push({ name: 'signTransaction + verify', ok: txOk });

	// 2. Personal message signature verifies
	const msg = new TextEncoder().encode(`hello @ ${Date.now()}`);
	const msgSig = await signer.signPersonalMessage(msg);
	const msgOk = await signer.getPublicKey().verifyPersonalMessage(msg, msgSig.signature);
	checks.push({ name: 'signPersonalMessage + verify', ok: msgOk });

	// 3. Address derived from the serialized signature's embedded pubkey matches
	try {
		const parsed = parseSerializedSignature(txSig.signature);
		if (!parsed.publicKey) throw new Error('parsed.publicKey missing');
		const pub =
			scheme === 'ED25519'
				? new Ed25519PublicKey(parsed.publicKey)
				: new Secp256r1PublicKey(parsed.publicKey);
		const addrFromSig = pub.toSuiAddress();
		checks.push({
			name: 'pubkey embedded in signature derives to same address',
			ok: addrFromSig === address,
			detail: addrFromSig === address ? undefined : `got ${addrFromSig}`,
		});

		// Also check scheme flag in the serialized signature
		const expectedScheme: SignatureScheme = scheme;
		checks.push({
			name: 'signature scheme flag matches',
			ok: parsed.signatureScheme === expectedScheme,
			detail:
				parsed.signatureScheme === expectedScheme ? undefined : `got ${parsed.signatureScheme}`,
		});
	} catch (err) {
		checks.push({
			name: 'pubkey embedded in signature derives to same address',
			ok: false,
			detail: (err as Error).message,
		});
	}

	// 4. Private key handle is non-extractable
	const privateKey = (signer as unknown as { privateKey?: CryptoKey }).privateKey;
	if (privateKey) {
		checks.push({
			name: 'privateKey is a non-extractable CryptoKey',
			ok: privateKey.extractable === false,
			detail: privateKey.extractable ? 'extractable=true' : undefined,
		});
	}

	// 5. Reload from backend, address still matches
	if (!readOnly) {
		const reloaded = await loadKeyringSigner({ account, service, backend });
		if (!reloaded) {
			checks.push({
				name: 'reload from backend',
				ok: false,
				detail: 'loadKeyringSigner returned null',
			});
		} else {
			checks.push({
				name: 'reload from backend yields same address',
				ok: reloaded.getPublicKey().toSuiAddress() === address,
				detail:
					reloaded.getPublicKey().toSuiAddress() === address
						? undefined
						: `got ${reloaded.getPublicKey().toSuiAddress()}`,
			});
		}
	}

	return checks;
}

function report(checks: Check[]) {
	for (const c of checks) {
		const mark = c.ok ? color.green('✓') : color.red('✗');
		const detail = c.detail ? color.gray(` — ${c.detail}`) : '';
		console.log(`    ${mark} ${c.name}${detail}`);
	}
	const allOk = checks.every((c) => c.ok);
	if (!allOk) console.log(color.red(`    ${checks.filter((c) => !c.ok).length} check(s) failed`));
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
