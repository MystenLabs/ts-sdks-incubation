import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SnapshotRecord } from '../engine/types.js';

const exec = promisify(execFile);

export type KilledKind = 'docker' | 'process';

export interface KilledEntry {
	name: string;
	kind: KilledKind;
	ref: string;
}

export interface KillFromSnapshotOptions {
	out?: NodeJS.WriteStream;
	json?: boolean;
}

// Shared "walk a snapshot for runner-shaped states and best-effort
// kill them" logic, used by both `reset` and `stack down`. Pattern-
// matches on the persisted shapes of DockerContainerState and
// HostProcessState (the only two runners today). Failures don't
// throw — a missing container or already-dead pid is normal.
export async function killFromSnapshot(
	snapshot: SnapshotRecord,
	opts: KillFromSnapshotOptions = {},
): Promise<KilledEntry[]> {
	const out = opts.out;
	const quiet = opts.json === true || out === undefined;
	const killed: KilledEntry[] = [];

	for (const [name, nodeState] of Object.entries(snapshot.nodeStates)) {
		const state = nodeState.state;
		if (!isPlainObject(state)) continue;
		if (looksLikeDockerContainerState(state)) {
			const containerId = state.containerId as string;
			if (await dockerContainerExists(containerId)) {
				if (!quiet) {
					out!.write(`stopping container ${containerId.slice(0, 12)} (${name})\n`);
				}
				try {
					await exec('docker', ['rm', '-f', containerId]);
					killed.push({ name, kind: 'docker', ref: containerId });
				} catch (err) {
					if (!quiet) {
						out!.write(
							`  ! docker rm -f ${containerId.slice(0, 12)} failed: ${asMessage(err)}\n`,
						);
					}
				}
			}
		} else if (looksLikeHostProcessState(state)) {
			const pid = state.pid as number;
			if (isAlive(pid)) {
				if (!quiet) {
					out!.write(`stopping process pid=${pid} (${name})\n`);
				}
				try {
					process.kill(pid, 'SIGTERM');
					killed.push({ name, kind: 'process', ref: String(pid) });
				} catch (err) {
					if (!quiet) out!.write(`  ! kill ${pid} failed: ${asMessage(err)}\n`);
				}
			}
		}
	}
	return killed;
}

// Read-only shape probes — same predicates `reset` used to inline.
// Surface them so callers (e.g. `stack list`) can count
// "running" runners without trying to kill anything.

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function looksLikeDockerContainerState(s: Record<string, unknown>): boolean {
	return (
		typeof s.containerId === 'string' &&
		typeof s.image === 'string' &&
		typeof s.hostPorts === 'object' &&
		s.hostPorts !== null
	);
}

export function looksLikeHostProcessState(s: Record<string, unknown>): boolean {
	return typeof s.pid === 'number' && typeof s.command === 'string' && Array.isArray(s.args);
}

export async function dockerContainerExists(id: string): Promise<boolean> {
	try {
		await exec('docker', ['inspect', id]);
		return true;
	} catch {
		return false;
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function asMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
