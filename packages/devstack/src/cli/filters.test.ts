import { describe, expect, it } from 'vitest';

import type { Action, ResolvedTarget, SeedAction } from '../core/types.js';
import { applyFilter, deployFilter, emitOnlyFilter } from './filters.js';

const localnet: ResolvedTarget = { network: 'localnet', stack: 'main', rpcUrl: '' };
const testnet: ResolvedTarget = { network: 'testnet', stack: 'main', rpcUrl: 'https://t' };
const mainnet: ResolvedTarget = { network: 'mainnet', stack: 'main', rpcUrl: 'https://m' };

const make = <T extends Action['type']>(type: T, extras: Partial<Action> = {}): Action =>
	({
		name: `${type}.x`,
		type,
		...extras,
	}) as Action;

describe('deployFilter', () => {
	it('skips Service on every network', () => {
		expect(deployFilter(make('Service'), localnet)).toBe(false);
		expect(deployFilter(make('Service'), testnet)).toBe(false);
	});

	it('runs Build/Publish/Register/Emit on every network (preserves pre-C1 behavior)', () => {
		for (const t of [localnet, testnet, mainnet] as const) {
			expect(deployFilter(make('Build'), t)).toBe(true);
			expect(deployFilter(make('Publish'), t)).toBe(true);
			expect(deployFilter(make('Register'), t)).toBe(true);
			expect(deployFilter(make('Emit'), t)).toBe(true);
		}
	});

	it('runs Seed on localnet always', () => {
		expect(deployFilter(make('Seed') as SeedAction, localnet)).toBe(true);
	});

	it('gates Seed on live nets by liveNetworks', () => {
		const opt = make('Seed', { liveNetworks: ['testnet'] }) as SeedAction;
		expect(deployFilter(opt, testnet)).toBe(true);
		expect(deployFilter(opt, mainnet)).toBe(false);
		const allLive = make('Seed', { liveNetworks: true }) as SeedAction;
		expect(deployFilter(allLive, mainnet)).toBe(true);
		const localOnly = make('Seed') as SeedAction;
		expect(deployFilter(localOnly, testnet)).toBe(false);
	});
});

describe('applyFilter', () => {
	it('runs every action type on localnet', () => {
		for (const type of ['Build', 'Service', 'Publish', 'Register', 'Emit'] as const) {
			expect(applyFilter(make(type), localnet)).toBe(true);
		}
		expect(applyFilter(make('Seed') as SeedAction, localnet)).toBe(true);
	});

	it('skips Service AND Build on live nets', () => {
		expect(applyFilter(make('Service'), testnet)).toBe(false);
		expect(applyFilter(make('Build'), testnet)).toBe(false);
		expect(applyFilter(make('Build'), mainnet)).toBe(false);
	});

	it('runs Publish/Register/Emit on live nets', () => {
		expect(applyFilter(make('Publish'), testnet)).toBe(true);
		expect(applyFilter(make('Register'), testnet)).toBe(true);
		expect(applyFilter(make('Emit'), testnet)).toBe(true);
	});

	it('gates Seed on live nets by liveNetworks', () => {
		expect(applyFilter(make('Seed') as SeedAction, testnet)).toBe(false);
		expect(applyFilter(make('Seed', { liveNetworks: true }) as SeedAction, testnet)).toBe(true);
	});
});

describe('emitOnlyFilter', () => {
	it('returns true only for Emit', () => {
		expect(emitOnlyFilter(make('Emit'), localnet)).toBe(true);
		expect(emitOnlyFilter(make('Build'), localnet)).toBe(false);
		expect(emitOnlyFilter(make('Service'), localnet)).toBe(false);
		expect(emitOnlyFilter(make('Publish'), testnet)).toBe(false);
		expect(emitOnlyFilter(make('Register'), testnet)).toBe(false);
		expect(emitOnlyFilter(make('Seed') as SeedAction, localnet)).toBe(false);
	});
});
