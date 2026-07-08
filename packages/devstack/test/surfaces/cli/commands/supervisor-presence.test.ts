// Supervisor presence probe — reads roster.json and reports live-or-not.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { probeSupervisorPresence } from '../../../../src/surfaces/cli/commands/supervisor-presence.ts';
import { processStartTime } from '../../../../src/substrate/runtime/cross-process/liveness.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'presence-test-'));

describe('probeSupervisorPresence', () => {
	it.effect('returns live=false when the roster is missing', () =>
		Effect.gen(function* () {
			const root = fresh();
			try {
				const presence = yield* probeSupervisorPresence(join(root, 'roster.json'));
				expect(presence.live).toBe(false);
				expect(presence.pid).toBeNull();
				expect(presence.graphInputId).toBeNull();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('returns live=true when own PID is in roster', () =>
		Effect.gen(function* () {
			const root = fresh();
			try {
				const rosterFile = join(root, 'roster.json');
				const realStartTime = processStartTime(process.pid) ?? 0;
				const doc = {
					version: 1 as const,
					holders: [
						{
							pid: process.pid,
							startTime: realStartTime,
							hostname: nodeHostname(),
							claimedAt: Date.now(),
							heartbeatAt: Date.now(),
							intent: 'normal' as const,
						},
					],
				};
				mkdirSync(root, { recursive: true });
				writeFileSync(rosterFile, JSON.stringify(doc), 'utf8');
				const presence = yield* probeSupervisorPresence(rosterFile);
				expect(presence.live).toBe(true);
				expect(presence.pid).toBe(process.pid);
				expect(presence.graphInputId).toBeNull();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('returns the live holder graph input id when present', () =>
		Effect.gen(function* () {
			const root = fresh();
			try {
				const rosterFile = join(root, 'roster.json');
				const realStartTime = processStartTime(process.pid) ?? 0;
				const doc = {
					version: 1 as const,
					holders: [
						{
							pid: process.pid,
							startTime: realStartTime,
							hostname: nodeHostname(),
							claimedAt: Date.now(),
							heartbeatAt: Date.now(),
							intent: 'normal' as const,
							graphInputId: 'graph-fixture',
						},
					],
				};
				mkdirSync(root, { recursive: true });
				writeFileSync(rosterFile, JSON.stringify(doc), 'utf8');
				const presence = yield* probeSupervisorPresence(rosterFile);
				expect(presence.live).toBe(true);
				expect(presence.graphInputId).toBe('graph-fixture');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('returns live=false when only dead PIDs are in roster', () =>
		Effect.gen(function* () {
			const root = fresh();
			try {
				const rosterFile = join(root, 'roster.json');
				const doc = {
					version: 1 as const,
					holders: [
						{
							pid: 1, // init, but startTime mismatch is the signal
							startTime: 9999999, // bogus stamp; checkHolderLiveness probes ps -o lstart and will mismatch
							hostname: nodeHostname(),
							claimedAt: 0,
							heartbeatAt: 0,
							intent: 'normal' as const,
						},
					],
				};
				mkdirSync(root, { recursive: true });
				writeFileSync(rosterFile, JSON.stringify(doc), 'utf8');
				const presence = yield* probeSupervisorPresence(rosterFile);
				expect(presence.live).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
