// Per-stack keystore. Manages on-disk Ed25519 keypairs at
// `<appDir>/.devstack/stacks/<stack>/.keys/<account>.key`, written as a
// single bech32 (`suiprivkey1...`) line. The Vite `virtual:devstack-keys`
// plugin reads these directly so the dev wallet picks up the same
// identities the supervisor faucets. `loadOrGenerateKeypair` is the
// implementation behind `generatedKeypair()` (the implicit localnet
// fallback factory in `helpers/signers.ts`) and is also called by the
// sui plugin's accounts action via `ctx.accounts.get(name)`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { stackDir } from '../runtime/active-stack.js';

export function keysDir(appDir: string, stack: string): string {
	return join(stackDir(appDir, stack), '.keys');
}

export function keyFilePath(appDir: string, stack: string, accountName: string): string {
	return join(keysDir(appDir, stack), `${accountName}.key`);
}

export function loadOrGenerateKeypair(
	appDir: string,
	stack: string,
	accountName: string,
): { keypair: Ed25519Keypair; created: boolean } {
	const path = keyFilePath(appDir, stack, accountName);
	if (existsSync(path)) {
		const bech32 = readFileSync(path, 'utf8').trim();
		const decoded = decodeSuiPrivateKey(bech32);
		if (decoded.scheme !== 'ED25519') {
			throw new Error(
				`devstack loadOrGenerateKeypair: ${path} contains a ${decoded.scheme} key; only Ed25519 is supported`,
			);
		}
		return { keypair: Ed25519Keypair.fromSecretKey(decoded.secretKey), created: false };
	}
	const keypair = new Ed25519Keypair();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${keypair.getSecretKey()}\n`, { mode: 0o600 });
	return { keypair, created: true };
}
