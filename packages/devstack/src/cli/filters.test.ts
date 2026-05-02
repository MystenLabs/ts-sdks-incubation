import { describe, expect, it } from 'vitest';

import type { Action, ResolvedTarget, SeedAction } from '../core/types.js';
import { applyFilter, applyTestSetupFilter, deployFilter, emitOnlyFilter } from './filters.js';

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

	it('skips HostProcess on every network', () => {
		expect(deployFilter(make('HostProcess'), localnet)).toBe(false);
		expect(deployFilter(make('HostProcess'), testnet)).toBe(false);
		expect(deployFilter(make('HostProcess'), mainnet)).toBe(false);
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

	it('skips Service, HostProcess AND Build on live nets', () => {
		expect(applyFilter(make('Service'), testnet)).toBe(false);
		expect(applyFilter(make('HostProcess'), testnet)).toBe(false);
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

describe('setup-action scope filtering', () => {
	const testStack: ResolvedTarget = { network: 'localnet', stack: 'test', rpcUrl: '' };
	const testNamedStack: ResolvedTarget = {
		network: 'localnet',
		stack: 'test-shard-1',
		rpcUrl: '',
	};

	it("'always' (default) runs on every stack and network", () => {
		expect(applyFilter(make('Publish'), localnet)).toBe(true);
		expect(applyFilter(make('Publish'), testStack)).toBe(true);
		expect(applyFilter(make('Publish', { scope: 'always' }), testnet)).toBe(true);
	});

	it("'localnet-only' skips on testnet/mainnet", () => {
		const action = make('Publish', { scope: 'localnet-only' });
		expect(applyFilter(action, localnet)).toBe(true);
		expect(applyFilter(action, testStack)).toBe(true);
		expect(applyFilter(action, testnet)).toBe(false);
		expect(applyFilter(action, mainnet)).toBe(false);
	});

	it("'test-only' runs only on localnet stacks named 'test*'", () => {
		const action = make('Publish', { scope: 'test-only' });
		expect(applyFilter(action, localnet)).toBe(false); // stack='main'
		expect(applyFilter(action, testStack)).toBe(true);
		expect(applyFilter(action, testNamedStack)).toBe(true);
		expect(applyFilter(action, testnet)).toBe(false); // wrong network
	});

	it('scope filter applies to deployFilter too', () => {
		const action = make('Publish', { scope: 'test-only' });
		expect(deployFilter(action, localnet)).toBe(false);
		expect(deployFilter(action, testStack)).toBe(true);
	});

	it('scope filter applies to applyTestSetupFilter too', () => {
		const action = make('Publish', { scope: 'test-only' });
		expect(applyTestSetupFilter(action, localnet)).toBe(false);
		expect(applyTestSetupFilter(action, testStack)).toBe(true);
	});
});
