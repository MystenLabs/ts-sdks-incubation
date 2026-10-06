// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atom } from 'nanostores';
import { describe, expect, it, vi } from 'vitest';
import { createCctpKit } from '../../src/core/index.js';
import type { AnyDAppKit, WalletLayer } from '../../src/core/types.js';
import { createInMemoryStorage } from '../../src/utils/storage.js';
import type { WalletAdapters } from '../../src/wallets/types.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/** Every package an entry point reaches through static or dynamic imports of its own source. */
function packagesReachedFrom(entry: string): Set<string> {
	const seen = new Set<string>();
	const packages = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const source = readFileSync(file, 'utf8');
		const specifiers = [
			...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
			...source.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
		].map((match) => match[1]!);
		for (const specifier of specifiers) {
			if (specifier.startsWith('.')) {
				const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
				visit(existsSync(target) ? target : `${target}x`);
			} else {
				packages.add(
					specifier
						.split('/')
						.slice(0, specifier.startsWith('@') ? 2 : 1)
						.join('/'),
				);
			}
		}
	};
	visit(resolve(SRC, entry));
	return packages;
}

describe('the Reown packages are optional', () => {
	// They are optional peers. An entry point that imports them, even lazily, makes every
	// bundler that builds a host resolve them, installed or not.
	it.each(['index.ts', 'web/index.ts', 'react/index.ts', 'react/ui.ts'])(
		'%s does not reach them',
		(entry) => {
			const reown = [...packagesReachedFrom(entry)].filter((name) => name.startsWith('@reown/'));
			expect(reown).toEqual([]);
		},
	);

	it('appkit.ts is the entry point that does', () => {
		expect([...packagesReachedFrom('appkit.ts')]).toEqual(
			expect.arrayContaining([
				'@reown/appkit',
				'@reown/appkit-adapter-wagmi',
				'@reown/appkit-adapter-solana',
			]),
		);
	});
});

describe('the wallet layer', () => {
	const dAppKit = {
		stores: {
			$connection: atom({ account: { address: `0x${'ab'.repeat(32)}` } }),
			$currentNetwork: atom('mainnet'),
		},
		getClient: () => ({ core: {} }),
	} as unknown as AnyDAppKit;
	const quiet = { fetch: vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 })) };
	const adapter = (ecosystem: 'evm' | 'solana') => ({
		ecosystem,
		getAccount: () => null,
		subscribe: () => () => undefined,
		connect: vi.fn(async () => undefined),
		disconnect: async () => undefined,
	});

	it('says what to configure when there is none', async () => {
		const kit = createCctpKit({
			dAppKit,
			network: 'mainnet',
			storage: createInMemoryStorage(),
			iris: quiet,
		});
		await expect(kit.connect('evm')).rejects.toThrow(
			/No EVM wallet is configured.*appKitWallets\(\)/,
		);
		await expect(kit.connect('solana')).rejects.toThrow(/No Solana wallet is configured/);
		kit.destroy();
	});

	it('is loaded once, when a wallet is first needed, and yields to adapters the host passes', async () => {
		const mine = adapter('evm');
		const fromLayer = { evm: adapter('evm'), solana: adapter('solana') };
		const layer = vi.fn<WalletLayer>(async () => fromLayer as unknown as WalletAdapters);
		const kit = createCctpKit({
			dAppKit,
			network: 'mainnet',
			direction: 'inflow',
			storage: createInMemoryStorage(),
			iris: quiet,
			wallets: { evm: mine as never, layer },
		});
		await kit.connect('evm');
		await kit.connect('solana');
		expect(layer).toHaveBeenCalledTimes(1);
		expect(layer.mock.calls[0]![0]).toMatchObject({ network: 'mainnet' });
		expect(mine.connect).toHaveBeenCalledTimes(1);
		expect(fromLayer.evm.connect).not.toHaveBeenCalled();
		expect(fromLayer.solana.connect).toHaveBeenCalledTimes(1);
		kit.destroy();
	});
});
