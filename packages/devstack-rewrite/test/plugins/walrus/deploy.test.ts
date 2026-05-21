// Unit tests for the walrus deploy-output parser. The parser shape
// is the contract between the `walrus-deploy` binary's stdout/output
// file and the plugin's `CachedDeployState` shape — any drift in the
// upstream output format surfaces here.

import { describe, expect, it } from 'vitest';

import { parseDeployOutput } from '../../../src/plugins/walrus/deploy.ts';

describe('parseDeployOutput', () => {
	it('extracts package_id / system_object / staking_object from key:value lines', () => {
		const stdout = [
			'package_id: 0xabc111',
			'system_object: 0xabc222',
			'staking_object: 0xabc333',
			'exchange_object: 0xabc444',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xabc111');
		expect(out!.systemObject).toBe('0xabc222');
		expect(out!.stakingObject).toBe('0xabc333');
		expect(out!.exchangeObject).toBe('0xabc444');
	});

	it('also matches the longer `walrus_package_id` key', () => {
		const stdout = [
			'walrus_package_id: 0xdef111',
			'system_object: 0xdef222',
			'staking_object: 0xdef333',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xdef111');
	});

	it('treats `None` as absent for optional fields', () => {
		const stdout = [
			'package_id: 0xeee111',
			'system_object: 0xeee222',
			'staking_object: 0xeee333',
			'exchange_object: None',
			'upgrade_manager_object: None',
			'treasury_object: None',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.exchangeObject).toBeUndefined();
		expect(out!.upgradeManagerObject).toBeUndefined();
		expect(out!.treasuryObject).toBeUndefined();
	});

	it('returns null when any required field is missing', () => {
		// Missing staking_object — should fail to parse.
		const stdout = ['package_id: 0xddd111', 'system_object: 0xddd222'].join('\n');
		expect(parseDeployOutput(stdout)).toBeNull();
	});

	it('is tolerant of surrounding chatter (walrus-deploy logs around the summary)', () => {
		const stdout = [
			'2026-05-20T12:34:56.789Z  INFO walrus_deploy: starting deploy',
			'2026-05-20T12:34:57.000Z  INFO walrus_deploy: faucet ok',
			'==== deploy-walrus summary ====',
			'package_id: 0xfff111',
			'system_object: 0xfff222',
			'staking_object: 0xfff333',
			'exchange_object: 0xfff444',
			'2026-05-20T12:35:01.000Z  INFO walrus_deploy: done',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xfff111');
		expect(out!.exchangeObject).toBe('0xfff444');
	});

	it('tolerates an `=` separator as well as `:`', () => {
		const stdout = [
			'package_id = 0xc1c1c1',
			'system_object = 0xc2c2c2',
			'staking_object = 0xc3c3c3',
		].join('\n');
		const out = parseDeployOutput(stdout);
		expect(out).not.toBeNull();
		expect(out!.walrusPackageId).toBe('0xc1c1c1');
	});
});
