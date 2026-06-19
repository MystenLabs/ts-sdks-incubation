// `writeNetworkDeploymentFile` guard tests.
//
// The `dump-deployment --network <net>` wiring refuses to emit a committed
// `deployments/<net>.ts` for the LIVE LOCAL network — a committed deployment is
// for real networks by definition, never the throwaway dev stack. The guard
// fires on EITHER the canonical local name (`localnet`) OR any unit flagged
// `local: true` (a renamed-but-still-local unit). Neither arm has coverage from
// the CLI dispatch tests (they mock `dumpDeployment.run`) nor the
// `deployment-network-file.test.ts` renderer tests (that function carries no
// such guard). These exercise the guard directly: it fails with a
// `CliUsageError` and writes NO file, and the happy path (a real `testnet`
// unit) writes `deployments/testnet.ts`.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Option } from 'effect';

import { writeNetworkDeploymentFile } from '../../../src/cli/wirings/dump-deployment.ts';
import type {
	DevstackDeployment,
	NetworkDeployment,
} from '../../../src/orchestrators/codegen/deployment.ts';

/** A fully-resolved, NON-local `testnet` unit — the happy-path shape a real
 *  `networks.testnet` envelope entry carries. */
const testnetUnit: NetworkDeployment = {
	network: 'testnet',
	rpc: 'https://fullnode.testnet.sui.io',
	chainId: 'sui:testnet',
	faucet: 'https://faucet.testnet.sui.io',
	packages: { counter: { id: '0xabc' } },
	mvrOverrides: {
		packages: { '@local/counter': '0xabc' },
		types: {},
	},
};

/** The live LOCAL unit boot writes under `localnet` — flagged `local: true`. */
const localUnit: NetworkDeployment = {
	network: 'localnet',
	rpc: 'http://127.0.0.1:9000',
	local: true,
	packages: {},
	mvrOverrides: { packages: {}, types: {} },
};

/** Build an envelope keyed by the supplied network units. */
const envelopeOf = (networks: Record<string, NetworkDeployment>): DevstackDeployment => ({
	defaultNetwork: Object.keys(networks)[0]!,
	networks,
	accounts: {},
});

let projectRoot: string;

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), 'dump-deployment-test-'));
});

afterEach(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

describe('writeNetworkDeploymentFile — live-local guard', () => {
	it('rejects `--network localnet` (the local name) and writes no file', async () => {
		const envelope = envelopeOf({ localnet: localUnit });
		const exit = await Effect.runPromiseExit(
			writeNetworkDeploymentFile(envelope, 'localnet', projectRoot),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		if (Option.isSome(errOpt)) {
			expect(errOpt.value._tag).toBe('CliUsageError');
		}
		// NO committed file written — the throwaway dev stack must not be captured.
		expect(existsSync(join(projectRoot, 'deployments'))).toBe(false);
	});

	it('rejects a non-local NAME whose unit is flagged `local: true` and writes no file', async () => {
		// The unit is keyed under `testnet` (a real-network name) but still carries
		// the dev `local` flag — proves the `unit.local === true` arm fires
		// independently of the name check.
		const envelope = envelopeOf({ testnet: { ...testnetUnit, local: true } });
		const exit = await Effect.runPromiseExit(
			writeNetworkDeploymentFile(envelope, 'testnet', projectRoot),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		const errOpt = Exit.findErrorOption(exit);
		expect(Option.isSome(errOpt)).toBe(true);
		if (Option.isSome(errOpt)) {
			expect(errOpt.value._tag).toBe('CliUsageError');
		}
		expect(existsSync(join(projectRoot, 'deployments'))).toBe(false);
	});
});

describe('writeNetworkDeploymentFile — happy path', () => {
	it('writes deployments/testnet.ts for a real, non-local network', async () => {
		const envelope = envelopeOf({ testnet: testnetUnit });
		const exit = await Effect.runPromiseExit(
			writeNetworkDeploymentFile(envelope, 'testnet', projectRoot),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		const outFile = join(projectRoot, 'deployments', 'testnet.ts');
		if (Exit.isSuccess(exit)) {
			expect(exit.value).toBe(outFile);
		}
		expect(existsSync(outFile)).toBe(true);
		const text = readFileSync(outFile, 'utf8');
		expect(text).toContain('satisfies AppNetworkDeployment');
		expect(text).toContain("network: 'testnet'");
	});
});
