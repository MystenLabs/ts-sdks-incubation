import { describe, expect, it } from 'vitest';

import type { Action, ResolvedTarget, SeedAction } from '../core/types.js';
import { applyFilter, applyTestSetupFilter, emitOnlyFilter } from './filters.js';

const localnet: ResolvedTarget = { network: 'localnet', stack: 'main', rpcUrl: '' };
const testnet: ResolvedTarget = { network: 'testnet', stack: 'main', rpcUrl: 'https://t' };
const mainnet: ResolvedTarget = { network: 'mainnet', stack: 'main', rpcUrl: 'https://m' };

const make = <T extends Action['type']>(type: T, extras: Partial<Action> = {}): Action =>
	({
		name: `${type}.x`,
		type,
		...extras,
	}) as Action;

describe('applyFilter', () => {
	it('runs every action type on localnet', () => {
		for (const type of [
			'Build',
			'Service',
			'HostProcess',
			'Publish',
			'Register',
			'Emit',
		] as const) {
			expect(applyFilter(make(type), localnet)).toBe(true);
		}
		expect(applyFilter(make('Seed') as SeedAction, localnet)).toBe(true);
	});

	it('skips Service + HostProcess on live nets (no docker assumed on prod)', () => {
		expect(applyFilter(make('Service'), testnet)).toBe(false);
		expect(applyFilter(make('HostProcess'), testnet)).toBe(false);
		expect(applyFilter(make('Service'), mainnet)).toBe(false);
		expect(applyFilter(make('HostProcess'), mainnet)).toBe(false);
	});

	it('runs Build/Publish/Register/Emit/Verify on live nets', () => {
		for (const t of [testnet, mainnet] as const) {
			expect(applyFilter(make('Build'), t)).toBe(true);
			expect(applyFilter(make('Publish'), t)).toBe(true);
			expect(applyFilter(make('Register'), t)).toBe(true);
			expect(applyFilter(make('Emit'), t)).toBe(true);
			expect(applyFilter(make('Verify'), t)).toBe(true);
		}
	});

	it('gates Seed on live nets by networks', () => {
		expect(applyFilter(make('Seed') as SeedAction, testnet)).toBe(false);
		expect(
			applyFilter(
				make('Seed', { networks: ['localnet', 'testnet'] }) as SeedAction,
				testnet,
			),
		).toBe(true);
	});
});

describe('applyTestSetupFilter', () => {
	it('skips HostProcess on localnet (the test-setup race fix)', () => {
		expect(applyTestSetupFilter(make('HostProcess'), localnet)).toBe(false);
	});

	it('still runs Service on localnet (containers detach and survive process exit)', () => {
		expect(applyTestSetupFilter(make('Service'), localnet)).toBe(true);
	});

	it('runs the rest of the localnet graph (Build/Publish/Register/Seed/Emit/Verify)', () => {
		for (const type of ['Build', 'Publish', 'Register', 'Emit', 'Verify'] as const) {
			expect(applyTestSetupFilter(make(type), localnet)).toBe(true);
		}
		expect(applyTestSetupFilter(make('Seed') as SeedAction, localnet)).toBe(true);
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

describe('action network filtering', () => {
	it('actions without `networks` run on every target', () => {
		expect(applyFilter(make('Publish'), localnet)).toBe(true);
		expect(applyFilter(make('Publish'), testnet)).toBe(true);
	});

	it("`networks: ['localnet']` skips on testnet/mainnet", () => {
		const action = make('Publish', { networks: ['localnet'] });
		expect(applyFilter(action, localnet)).toBe(true);
		expect(applyFilter(action, testnet)).toBe(false);
		expect(applyFilter(action, mainnet)).toBe(false);
	});

	it("`networks: ['testnet']` runs only on testnet", () => {
		const action = make('Publish', { networks: ['testnet'] });
		expect(applyFilter(action, localnet)).toBe(false);
		expect(applyFilter(action, testnet)).toBe(true);
		expect(applyFilter(action, mainnet)).toBe(false);
	});

	it('network filter applies to applyTestSetupFilter too', () => {
		const action = make('Publish', { networks: ['localnet'] });
		expect(applyTestSetupFilter(action, localnet)).toBe(true);
		expect(applyTestSetupFilter(action, testnet)).toBe(false);
	});
});
