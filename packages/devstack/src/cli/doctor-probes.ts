// L4-adjacent CLI infrastructure: doctor probe definitions.
//
// Per STYLE_GUIDE §7: `cli/*.ts` modules sit alongside the bin entry
// (`cli/main.ts`) and may import L3 orchestrator + L2 plugin barrels —
// they are NOT L4 surfaces proper. The router-profile probe needs
// both the L3 router orchestrator helpers (parsing dispatch files,
// matching profile labels, sorting entrypoint ports) and the built-in
// L2 router entrypoint composition; that wiring lives here.
//
// The probes themselves are read-only diagnostics: Docker reachable,
// `sui` CLI on PATH, state-dir writable, router profile state +
// dispatch leases + entrypoint listeners, orphan cross-process locks,
// fork-cache health. Each returns a typed `ProbeOutcome` and never
// throws. `required: true` means a `fail | unavailable` projects to
// `CliUnavailableError` and exits 69; non-required probes are
// informational.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { Effect } from 'effect';

import {
	dispatchFileIdFromFilename,
	makeDefaultRouterProfile,
	parseDispatchRouteFile,
	routerProfileLabelsMatch,
	uniqueSortedEntrypointPorts,
	type Entrypoint,
	type RouterProfile,
} from '../orchestrators/router/index.ts';
import { BUILT_IN_ENTRYPOINTS } from '../plugins/router-entrypoints.ts';
import { parseJsonTextSync } from '../substrate/runtime/runtime-decode.ts';
import {
	layerLivenessProbeScope,
	LivenessProbeScope,
	readRoster,
} from '../substrate/runtime/cross-process/index.ts';
import type { RosterHolder } from '../substrate/cross-process.ts';
import type { Probe, ProbeOutcome } from '../surfaces/cli/commands/doctor.ts';

const okOutcome = (detail?: string): ProbeOutcome =>
	detail !== undefined ? { status: 'ok', detail } : { status: 'ok' };

type CommandResult = { ok: true; out: string } | { ok: false; err: string };

const captureCommand = (
	cmd: string,
	args: ReadonlyArray<string>,
	timeoutMs = 3000,
): CommandResult => {
	try {
		const out = execFileSync(cmd, args as string[], {
			encoding: 'utf8',
			timeout: timeoutMs,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true, out: out.trim() };
	} catch (err) {
		return {
			ok: false,
			err: err instanceof Error ? err.message : String(err),
		};
	}
};

/** Probe: `docker version` resolves. */
export const dockerProbe: Probe = {
	name: 'docker',
	description: 'Docker daemon reachable',
	required: true,
	run: () =>
		Effect.sync(() => {
			const result = captureCommand('docker', ['version', '--format', '{{.Server.Version}}']);
			if (!result.ok) {
				return {
					status: 'fail',
					detail: `docker version failed: ${result.err}`,
				};
			}
			return okOutcome(`server ${result.out}`);
		}),
};

/** Probe: required CLIs on PATH (just sui-cli for fork-aware flows). */
export const suiCliProbe: Probe = {
	name: 'sui-cli',
	description: '`sui` CLI on PATH',
	required: false,
	run: () =>
		Effect.sync(() => {
			const result = captureCommand('sui', ['--version']);
			return result.ok
				? okOutcome(result.out)
				: {
						status: 'warn',
						detail: 'sui CLI not on PATH (only needed for live/fork modes)',
					};
		}),
};

/** Probe: a TCP port is FREE on localhost (resolves `true` when nothing
 *  is listening — connection refused/timeout — and `false` when a
 *  listener answers). Backs `routerProfileProbe`'s entrypoint-listener
 *  check. */
const probePortFree = (port: number, timeoutMs = 500): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port });
		const finish = (free: boolean): void => {
			socket.destroy();
			resolve(free);
		};
		const timer = setTimeout(() => finish(true), timeoutMs);
		socket.on('connect', () => {
			clearTimeout(timer);
			finish(false);
		});
		socket.on('error', () => {
			clearTimeout(timer);
			finish(true);
		});
	});

export type DoctorCommandRunner = typeof captureCommand;
export type PortAvailabilityProbe = typeof probePortFree;

export interface RouterProfileProbeOptions {
	readonly profile?: RouterProfile;
	readonly entrypoints?: ReadonlyArray<Entrypoint>;
	readonly command?: DoctorCommandRunner;
	readonly probePort?: PortAvailabilityProbe;
}

interface RouterDispatchScan {
	readonly status: 'absent' | 'ok' | 'not-directory' | 'unreadable';
	readonly files: number;
	readonly liveRoutes: number;
	readonly staleRoutes: number;
	readonly unknownOwnerRoutes: number;
	readonly corruptRouteFiles: number;
	readonly diagnostics: number;
	readonly safeToPrune: boolean;
}

interface RouterContainerStatus {
	readonly status: 'absent' | 'present' | 'invalid' | 'unavailable';
	readonly detail?: string;
	readonly running?: boolean;
	readonly labelsMatch?: boolean;
	readonly attachedToNetwork?: boolean;
	readonly publishedPorts?: ReadonlyArray<number>;
}

interface RouterNetworkStatus {
	readonly status: 'absent' | 'present' | 'invalid' | 'unavailable';
	readonly detail?: string;
	readonly id?: string;
}

const unknownRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const stringRecord = (value: unknown): Record<string, string> => {
	const rec = unknownRecord(value);
	if (rec === null) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(rec)) {
		if (typeof raw === 'string') out[key] = raw;
	}
	return out;
};

const fieldRecord = (
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> | null => unknownRecord(record[key]);

const fieldString = (record: Record<string, unknown>, key: string): string | null =>
	typeof record[key] === 'string' ? (record[key] as string) : null;

const fieldBoolean = (record: Record<string, unknown>, key: string): boolean | null =>
	typeof record[key] === 'boolean' ? (record[key] as boolean) : null;

const parseDockerInspectFirst = (out: string): Record<string, unknown> | null => {
	try {
		const parsed = parseJsonTextSync(out, {
			source: 'docker inspect',
			mkError: (issue) => issue,
		});
		if (Array.isArray(parsed)) return unknownRecord(parsed[0]);
		return unknownRecord(parsed);
	} catch {
		return null;
	}
};

const dockerObjectIsAbsent = (err: string): boolean =>
	/No such (object|container|network)|not found|No such/i.test(err);

const uniqueNumbers = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
	[...new Set(values)].sort((a, b) => a - b);

const inspectRouterContainer = (
	profile: RouterProfile,
	command: DoctorCommandRunner,
): RouterContainerStatus => {
	const result = command('docker', ['container', 'inspect', profile.containerName]);
	if (!result.ok) {
		return dockerObjectIsAbsent(result.err)
			? { status: 'absent' }
			: { status: 'unavailable', detail: result.err };
	}
	const doc = parseDockerInspectFirst(result.out);
	if (doc === null) return { status: 'invalid', detail: 'container inspect JSON was invalid' };
	const state = fieldRecord(doc, 'State') ?? {};
	const config = fieldRecord(doc, 'Config') ?? {};
	const networkSettings = fieldRecord(doc, 'NetworkSettings') ?? {};
	const networks = fieldRecord(networkSettings, 'Networks') ?? {};
	const ports = fieldRecord(networkSettings, 'Ports') ?? {};
	const publishedPorts: Array<number> = [];
	for (const bindings of Object.values(ports)) {
		if (!Array.isArray(bindings)) continue;
		for (const binding of bindings) {
			const rec = unknownRecord(binding);
			if (rec === null) continue;
			const rawPort = fieldString(rec, 'HostPort');
			if (rawPort !== null && /^\d+$/.test(rawPort)) {
				publishedPorts.push(Number.parseInt(rawPort, 10));
			}
		}
	}
	const labels = stringRecord(config.Labels);
	return {
		status: 'present',
		running: fieldBoolean(state, 'Running') === true,
		labelsMatch: routerProfileLabelsMatch(labels, profile),
		attachedToNetwork: Object.keys(networks).includes(profile.networkName),
		publishedPorts: uniqueNumbers(publishedPorts),
	};
};

const inspectRouterNetwork = (
	profile: RouterProfile,
	command: DoctorCommandRunner,
): RouterNetworkStatus => {
	const result = command('docker', ['network', 'inspect', profile.networkName]);
	if (!result.ok) {
		return dockerObjectIsAbsent(result.err)
			? { status: 'absent' }
			: { status: 'unavailable', detail: result.err };
	}
	const doc = parseDockerInspectFirst(result.out);
	if (doc === null) return { status: 'invalid', detail: 'network inspect JSON was invalid' };
	const id = fieldString(doc, 'Id');
	return id === null ? { status: 'present' } : { status: 'present', id };
};

const inspectRouterDispatch = (profile: RouterProfile): Effect.Effect<RouterDispatchScan> =>
	// Yield a fresh `LivenessProbeScope` so repeated lease owners across
	// many dispatch route files fork the OS probe once per pid.
	Effect.gen(function* () {
		if (!existsSync(profile.dispatchDir)) {
			return {
				status: 'absent' as const,
				files: 0,
				liveRoutes: 0,
				staleRoutes: 0,
				unknownOwnerRoutes: 0,
				corruptRouteFiles: 0,
				diagnostics: 0,
				safeToPrune: true,
			};
		}
		try {
			if (!statSync(profile.dispatchDir).isDirectory()) {
				return {
					status: 'not-directory' as const,
					files: 0,
					liveRoutes: 0,
					staleRoutes: 0,
					unknownOwnerRoutes: 1,
					corruptRouteFiles: 1,
					diagnostics: 1,
					safeToPrune: false,
				};
			}
		} catch {
			return {
				status: 'unreadable' as const,
				files: 0,
				liveRoutes: 0,
				staleRoutes: 0,
				unknownOwnerRoutes: 1,
				corruptRouteFiles: 1,
				diagnostics: 1,
				safeToPrune: false,
			};
		}
		let files: ReadonlyArray<string>;
		try {
			files = readdirSync(profile.dispatchDir);
		} catch {
			return {
				status: 'unreadable' as const,
				files: 0,
				liveRoutes: 0,
				staleRoutes: 0,
				unknownOwnerRoutes: 1,
				corruptRouteFiles: 1,
				diagnostics: 1,
				safeToPrune: false,
			};
		}
		const probe = yield* LivenessProbeScope;
		let routeFiles = 0;
		let liveRoutes = 0;
		let staleRoutes = 0;
		let unknownOwnerRoutes = 0;
		let corruptRouteFiles = 0;
		let diagnostics = 0;
		for (const filename of files) {
			const dispatchFileId = dispatchFileIdFromFilename(filename);
			if (dispatchFileId === null) continue;
			routeFiles += 1;
			let body: string;
			try {
				body = readFileSync(join(profile.dispatchDir, filename), 'utf8');
			} catch {
				corruptRouteFiles += 1;
				unknownOwnerRoutes += 1;
				diagnostics += 1;
				continue;
			}
			const parsed = parseDispatchRouteFile(body, dispatchFileId);
			diagnostics += parsed.diagnostics.length;
			if (parsed._tag === 'invalid') {
				corruptRouteFiles += 1;
				unknownOwnerRoutes += 1;
				continue;
			}
			if (parsed.route.lease === null) {
				unknownOwnerRoutes += 1;
				continue;
			}
			const leaseStatus = yield* probe
				.probeHolderLiveness(parsed.route.lease.owner)
				.pipe(Effect.catch(() => Effect.succeed('alive' as const)));
			if (leaseStatus === 'dead') staleRoutes += 1;
			else liveRoutes += 1;
		}
		const safeToPrune = liveRoutes === 0 && unknownOwnerRoutes === 0 && corruptRouteFiles === 0;
		return {
			status: 'ok' as const,
			files: routeFiles,
			liveRoutes,
			staleRoutes,
			unknownOwnerRoutes,
			corruptRouteFiles,
			diagnostics,
			safeToPrune,
		};
	}).pipe(Effect.provide(layerLivenessProbeScope));

const inspectRouterStateDir = (profile: RouterProfile): 'absent' | 'present' | 'not-directory' => {
	if (!existsSync(profile.stateDir)) return 'absent';
	try {
		return statSync(profile.stateDir).isDirectory() ? 'present' : 'not-directory';
	} catch {
		return 'not-directory';
	}
};

const summarizeRouterContainer = (container: RouterContainerStatus): string => {
	if (container.status !== 'present') return container.status;
	return [
		container.running === true ? 'running' : 'stopped',
		`labels=${container.labelsMatch === true ? 'ok' : 'mismatch'}`,
		`network=${container.attachedToNetwork === true ? 'attached' : 'missing'}`,
		`ports=${(container.publishedPorts ?? []).join(',') || 'none'}`,
	].join('/');
};

export const routerProfileProbe = (options: RouterProfileProbeOptions = {}): Probe => ({
	name: 'router-profile',
	description: 'router profile state, dispatch leases, and entrypoint listeners',
	required: false,
	run: () =>
		Effect.gen(function* () {
			const profile = options.profile ?? makeDefaultRouterProfile();
			const entrypoints = options.entrypoints ?? BUILT_IN_ENTRYPOINTS;
			const command = options.command ?? captureCommand;
			const probePort = options.probePort ?? probePortFree;
			const ports = uniqueSortedEntrypointPorts(entrypoints);
			const stateDirStatus = inspectRouterStateDir(profile);
			const dispatch = yield* inspectRouterDispatch(profile);
			const container = inspectRouterContainer(profile, command);
			const network = inspectRouterNetwork(profile, command);
			const listenerResults = yield* Effect.tryPromise({
				try: () =>
					Promise.all(
						ports.map(async (port) => ({
							port,
							free: await probePort(port),
						})),
					),
				catch: () => 'router entrypoint listener probe failed',
			}).pipe(Effect.catch(() => Effect.succeed(ports.map((port) => ({ port, free: true })))));
			const freePorts = listenerResults.filter((r) => r.free).map((r) => r.port);
			const occupiedPorts = listenerResults.filter((r) => !r.free).map((r) => r.port);
			const protectedRoutes =
				dispatch.liveRoutes + dispatch.unknownOwnerRoutes + dispatch.corruptRouteFiles;
			const problems: string[] = [];
			if (stateDirStatus === 'not-directory')
				problems.push(`${profile.stateDir} is not a directory`);
			if (dispatch.status === 'not-directory' || dispatch.status === 'unreadable') {
				problems.push(`dispatch dir is ${dispatch.status}`);
			}
			if (dispatch.unknownOwnerRoutes > 0 || dispatch.corruptRouteFiles > 0) {
				problems.push(
					`unknown/corrupt dispatch leases=${dispatch.unknownOwnerRoutes + dispatch.corruptRouteFiles}`,
				);
			}
			if (dispatch.staleRoutes > 0) problems.push(`stale dispatch leases=${dispatch.staleRoutes}`);
			if (protectedRoutes > 0 && (container.status !== 'present' || container.running !== true)) {
				problems.push('protected dispatch leases exist without a running router container');
			}
			if (container.status === 'invalid' || container.status === 'unavailable') {
				problems.push(
					`router container inspect ${container.status}: ${container.detail ?? 'unknown'}`,
				);
			}
			if (container.status === 'present') {
				if (container.labelsMatch !== true)
					problems.push('router container labels do not match profile');
				if (container.attachedToNetwork !== true) {
					problems.push('router container is not attached to profile network');
				}
				if (container.running === true && freePorts.length > 0) {
					problems.push(`router entrypoint listeners missing: ${freePorts.join(', ')}`);
				}
			}
			if (container.status !== 'present' && occupiedPorts.length > 0) {
				problems.push(
					`router entrypoint ports already in use without profile container: ${occupiedPorts.join(', ')}`,
				);
			}
			if (network.status === 'invalid' || network.status === 'unavailable') {
				problems.push(`router network inspect ${network.status}: ${network.detail ?? 'unknown'}`);
			}
			const detail = [
				`profile=${profile.id}`,
				`state=${stateDirStatus}`,
				`dispatch=${dispatch.status}:files=${dispatch.files},live=${dispatch.liveRoutes},stale=${dispatch.staleRoutes},unknown=${dispatch.unknownOwnerRoutes},corrupt=${dispatch.corruptRouteFiles},diagnostics=${dispatch.diagnostics},pruneSafe=${dispatch.safeToPrune ? 'yes' : 'no'}`,
				`container=${summarizeRouterContainer(container)}`,
				`network=${network.status}`,
				`entrypoints=${ports.join(', ') || 'none'}`,
			].join('; ');
			if (problems.length === 0) return okOutcome(detail);
			return {
				status: 'warn' as const,
				detail: `${detail}; ${problems.join('; ')}`,
			};
		}),
});

/** Probe: list orphaned stack locks under `<runtimeRoot>/<app>/`. A
 *  stack lock whose owner PID is dead is a stale-lock candidate that
 *  `--clean-locks` would reclaim. */
export const locksProbe = (appRoot: string): Probe => ({
	name: 'locks',
	description: 'stale cross-process locks',
	required: false,
	run: () =>
		Effect.gen(function* () {
			if (!existsSync(appRoot)) return okOutcome('(no app root yet)');
			const ownHost = nodeHostname();
			// Yield a fresh `LivenessProbeScope` so a single pid that
			// shows up in multiple stack rosters under this app root is
			// probed AT MOST once across the full lock scan.
			const probe = yield* LivenessProbeScope;
			let orphans = 0;
			let totalLive = 0;
			try {
				for (const entry of readdirSync(appRoot)) {
					if (entry.startsWith('.')) continue;
					const stackRoot = join(appRoot, entry);
					try {
						if (!statSync(stackRoot).isDirectory()) continue;
					} catch {
						continue;
					}
					const rosterFile = join(stackRoot, 'roster.json');
					if (!existsSync(rosterFile)) continue;
					const doc = yield* readRoster(rosterFile).pipe(
						Effect.catch(() =>
							Effect.succeed({ version: 1 as const, holders: [] as RosterHolder[] }),
						),
					);
					for (const holder of doc.holders) {
						const liveness = yield* probe
							.probeHolderLiveness(holder, ownHost)
							.pipe(Effect.catch(() => Effect.succeed('alive' as const)));
						if (liveness === 'alive') totalLive += 1;
						else orphans += 1;
					}
				}
			} catch (cause) {
				return {
					status: 'warn' as const,
					detail: `lock scan failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				};
			}
			if (orphans === 0) {
				return okOutcome(`${totalLive} live, 0 orphan`);
			}
			return {
				status: 'warn' as const,
				detail: `${orphans} orphan holder(s); rerun with --clean-locks`,
			};
		}).pipe(Effect.provide(layerLivenessProbeScope)),
});

/** Probe: state-dir is writable. Validates DEVSTACK_STATE_DIR resolves
 *  to a usable path (or the default ~/.devstack does). */
export const stateDirProbe = (stateDir: string): Probe => ({
	name: 'state-dir',
	description: 'state directory',
	required: true,
	run: () =>
		Effect.sync(() => {
			if (!existsSync(stateDir)) {
				return okOutcome(`${stateDir} (will be created)`);
			}
			try {
				const s = statSync(stateDir);
				if (!s.isDirectory()) {
					return {
						status: 'fail',
						detail: `${stateDir} is not a directory`,
					};
				}
				return okOutcome(stateDir);
			} catch (cause) {
				return {
					status: 'fail',
					detail: cause instanceof Error ? cause.message : String(cause),
				};
			}
		}),
});

/** Probe: optional fork-cache directory inspection. Returns the size
 *  of the cache (informational). */
export const forkCacheProbe = (appRoot: string): Probe => ({
	name: 'fork-cache',
	description: 'sui-fork cache',
	required: false,
	run: () =>
		Effect.sync(() => {
			const cacheDir = join(appRoot, '.fork-cache');
			if (!existsSync(cacheDir)) return okOutcome('(absent)');
			try {
				const size = countTreeSize(cacheDir);
				return okOutcome(`${size} entries`);
			} catch {
				return { status: 'warn', detail: 'fork cache scan failed' };
			}
		}),
});

const countTreeSize = (dir: string, depth = 0): number => {
	if (depth > 3) return 0;
	let n = 0;
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		try {
			const s = statSync(p);
			if (s.isFile()) n += 1;
			else if (s.isDirectory()) n += countTreeSize(p, depth + 1);
		} catch {
			// ignore
		}
	}
	return n;
};

/** Default probe set. `cli/main.ts` composes this with the resolved
 *  app root, runtime state dir, router profile, and router entrypoints. */
export const defaultProbes = (params: {
	readonly stateDir: string;
	readonly appRoot: string;
	readonly routerProfile?: RouterProfile;
	readonly routerEntrypoints?: ReadonlyArray<Entrypoint>;
}): ReadonlyArray<Probe> => [
	dockerProbe,
	suiCliProbe,
	stateDirProbe(params.stateDir),
	routerProfileProbe({
		...(params.routerProfile === undefined ? {} : { profile: params.routerProfile }),
		...(params.routerEntrypoints === undefined ? {} : { entrypoints: params.routerEntrypoints }),
	}),
	locksProbe(params.appRoot),
	forkCacheProbe(params.appRoot),
];
