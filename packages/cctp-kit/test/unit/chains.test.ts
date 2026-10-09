// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
	applyRpcOverrides,
	destinationsFor,
	EVM_MAINNET_CHAINS,
	EVM_TESTNET_CHAINS,
	getChainRegistry,
	resolveRoutes,
} from '../../src/chains/index.js';

describe('chain registry', () => {
	it('has unique keys, domains and chain ids per network', () => {
		for (const network of ['mainnet', 'testnet'] as const) {
			const chains = getChainRegistry(network);
			expect(new Set(chains.map((c) => c.key)).size).toBe(chains.length);
			expect(new Set(chains.map((c) => c.domain)).size).toBe(chains.length);
			const evm = chains.filter((c) => c.ecosystem === 'evm');
			expect(new Set(evm.map((c) => c.chainId)).size).toBe(evm.length);
			expect(chains.every((c) => c.isTestnet === (network === 'testnet'))).toBe(true);
		}
	});

	it('exposes every mainnet EVM chain on testnet except the ones Circle has no verified testnet for', () => {
		const mainnetKeys = EVM_MAINNET_CHAINS.map((c) => c.key).sort();
		const testnetKeys = EVM_TESTNET_CHAINS.map((c) => c.key).sort();
		expect(mainnetKeys.filter((k) => !testnetKeys.includes(k))).toEqual(['pharos']);
	});

	it('uses the EDGE-specific contract addresses only on EDGE mainnet', () => {
		const edge = EVM_MAINNET_CHAINS.find((c) => c.key === 'edge')!;
		expect(edge.tokenMessengerV2).toBe('0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c');
		const others = EVM_MAINNET_CHAINS.filter((c) => c.key !== 'edge');
		expect(new Set(others.map((c) => c.tokenMessengerV2)).size).toBe(1);
		expect(new Set(others.map((c) => c.messageTransmitterV2)).size).toBe(1);
	});

	it('writes every EVM address with a valid checksum', () => {
		// viem rejects a mixed-case address whose checksum is wrong before any wallet is asked,
		// so one mistyped letter makes a whole chain unusable.
		for (const chain of [...EVM_MAINNET_CHAINS, ...EVM_TESTNET_CHAINS]) {
			for (const address of [
				chain.usdcAddress,
				chain.tokenMessengerV2,
				chain.messageTransmitterV2,
			]) {
				expect(isAddress(address), `${chain.name} ${address}`).toBe(true);
			}
		}
	});

	it('never lists BNB Smart Chain (USYC only)', () => {
		expect(getChainRegistry('mainnet').some((c) => c.domain === 17)).toBe(false);
	});
});

describe('resolveRoutes', () => {
	const chains = getChainRegistry('mainnet');

	it('keeps Sui on one side only in both-direction mode', () => {
		const routes = resolveRoutes(chains, 'both');
		expect(routes.from.map((c) => c.key)).toContain('sui');
		expect(destinationsFor(routes, 'sui').some((c) => c.key === 'sui')).toBe(false);
		expect(destinationsFor(routes, 'base').map((c) => c.key)).toEqual(['sui']);
	});

	it('inflow mode only allows non-Sui sources and Sui destinations', () => {
		const routes = resolveRoutes(chains, 'inflow');
		expect(routes.from.some((c) => c.key === 'sui')).toBe(false);
		expect(routes.to.map((c) => c.key)).toEqual(['sui']);
	});

	it('outflow mode only allows Sui as the source', () => {
		const routes = resolveRoutes(chains, 'outflow');
		expect(routes.from.map((c) => c.key)).toEqual(['sui']);
		expect(routes.to.some((c) => c.key === 'sui')).toBe(false);
	});

	it('applies global and per-side allow/deny filters', () => {
		const routes = resolveRoutes(chains, 'both', {
			allow: ['sui', 'ethereum', 'base', 'solana'],
			from: { deny: ['solana'] },
			to: { allow: ['sui', 'base'] },
		});
		expect(routes.from.map((c) => c.key)).toEqual(['sui', 'ethereum', 'base']);
		expect(routes.to.map((c) => c.key)).toEqual(['sui', 'base']);
	});
});

describe('applyRpcOverrides', () => {
	const chains = getChainRegistry('mainnet');

	it('prepends by default and updates the viem chain', () => {
		const [base] = applyRpcOverrides(chains, { urls: { base: 'https://my.rpc' } }).filter(
			(c) => c.key === 'base',
		);
		expect(base!.rpcUrls[0]).toBe('https://my.rpc');
		expect(base!.rpcUrls.length).toBeGreaterThan(1);
		expect(base!.ecosystem === 'evm' && base!.viemChain.rpcUrls.default.http[0]).toBe(
			'https://my.rpc',
		);
	});

	it('replaces when asked', () => {
		const [sol] = applyRpcOverrides(chains, {
			urls: { solana: ['https://a', 'https://b'] },
			mode: 'replace',
		}).filter((c) => c.key === 'solana');
		expect(sol!.rpcUrls).toEqual(['https://a', 'https://b']);
	});
});

describe('icons and counterpart options', () => {
	it('attaches default icons and honours overrides', async () => {
		const { applyChainIcons, counterpartOptionsFor, suiSideFor } =
			await import('../../src/chains/index.js');
		const chains = getChainRegistry('mainnet');
		expect(chains.find((c) => c.key === 'base')!.icon).toMatch(/^https:\/\//);
		expect(chains.find((c) => c.key === 'edge')!.icon).toBeUndefined();
		const overridden = applyChainIcons(chains, { base: null, edge: 'data:image/svg+xml,x' });
		expect(overridden.find((c) => c.key === 'base')!.icon).toBeUndefined();
		expect(overridden.find((c) => c.key === 'edge')!.icon).toBe('data:image/svg+xml,x');

		const routes = resolveRoutes(chains, 'both');
		expect(suiSideFor('sui')).toBe('from');
		expect(suiSideFor('base')).toBe('to');
		expect(counterpartOptionsFor(routes, 'sui').some((c) => c.key === 'sui')).toBe(false);
		expect(counterpartOptionsFor(routes, 'base').map((c) => c.key)).toEqual(
			routes.from.filter((c) => c.key !== 'sui').map((c) => c.key),
		);
	});
});

describe('finality estimates', () => {
	it('every chain has a standard estimate and fast only where supported as a source', () => {
		for (const network of ['mainnet', 'testnet'] as const) {
			for (const chain of getChainRegistry(network)) {
				expect(chain.finality.standard[0]).toBeGreaterThan(0);
				expect(chain.finality.standard[1]).toBeGreaterThanOrEqual(chain.finality.standard[0]);
				expect(Boolean(chain.finality.fast)).toBe(chain.fastTransferAsSource);
			}
		}
	});
});
