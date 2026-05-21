// Container lifecycle state machine.
//
// Architecture § Lifecycle states. The (missing | running-match |
// running-mismatch | stopped-clean | stopped-unclean | stopped-
// mismatch) input states map to (adopt | resume | recreate | fresh)
// actions. The output handle is the running container.
//
// Architecture invariants encoded here:
//
//   §1  Name-atomic create — `docker create --name <stable>` collision
//       triggers `docker start <name>` adopt-fallback (single shot;
//       second collision = typed failure, no infinite loop).
//   §2  Label-driven inventory — we use `docker inspect <name>` for
//       the single-container probe path (cheaper than label-filtered
//       `ps`), but the labels are still STAMPED on create so sweep
//       can find us by labels later.
//   §5  Async network-connect — `network.ts::waitForIp` is called
//       after attach and before we declare ready.
//   §9  RecreatePolicy enum routed in — `never` refuses to recreate;
//       `on-failure` recreates on unclean shutdown + image mismatch;
//       `on-config-change` recreates ONLY on image mismatch (the
//       Move-build-container case — "this is fine to leave failed,
//       just don't auto-recreate; recreate when the config changes").

import { Deferred, Effect, Ref, Scope, Schema } from 'effect';

import type {
	ContainerHandle,
	ContainerPortPublish,
	EnsureContainerSpec,
	PortBindingReconciliation,
	RecreatePolicy,
} from '../../contracts/container-runtime.ts';
import { addClaim, removeClaim } from '../../substrate/runtime/cross-process/roster.ts';
import { StackPathsService } from '../../substrate/runtime/paths.ts';
import { DockerHost, DockerSpawner, dockerRun, dockerRunOk } from './client.ts';
import {
	ContainerCreateFailed,
	ContainerNameCollisionUnrecoverable,
	DaemonUnreachable,
	DockerInspectDecodeFailed,
	DockerInspectFailed,
	type DockerRuntimeError,
	ForeignDockerResource,
	RecreateRefused,
} from './errors.ts';
import {
	expectedContainerOwnershipLabels,
	ownershipMismatchDetail,
	renderContainerLabels,
} from './labels.ts';
import { connect, readIps, waitForIp } from './network.ts';
import {
	classifyExit,
	isDaemonUnreachableStderr,
	isNameCollisionStderr,
	isNoSuchContainerStderr,
	wrapCreateError,
	wrapGeneric,
} from './wrap.ts';

// -----------------------------------------------------------------------------
// State machine — pure decision (testable independently)
// -----------------------------------------------------------------------------

/** What `docker inspect <name>` told us. The `state` is the docker
 *  state string; we narrow into the lifecycle's input states below. */
export interface InspectFacts {
	readonly id: string;
	readonly running: boolean;
	readonly paused: boolean;
	readonly exitCode: number;
	readonly image: string;
	readonly mounts?: ReadonlyArray<InspectMount>;
	readonly portBindings?: ReadonlyArray<string>;
	readonly ports?: ReadonlyArray<ContainerPortPublish>;
	readonly effectivePortBindings?: ReadonlyArray<string>;
	readonly effectivePorts?: ReadonlyArray<ContainerPortPublish>;
	readonly command?: ReadonlyArray<string>;
	readonly labels?: Readonly<Record<string, string>>;
	readonly networks?: ReadonlyArray<string>;
}

export interface InspectMount {
	readonly source: string;
	readonly target: string;
	readonly readOnly?: boolean;
}

/** The closed set of actions the state machine can decide. */
export type RunAction =
	| { readonly kind: 'adopt'; readonly id: string }
	| { readonly kind: 'unpause-adopt'; readonly id: string }
	| { readonly kind: 'resume'; readonly id: string }
	| { readonly kind: 'recreate'; readonly id: string; readonly reason: RecreateReason }
	| { readonly kind: 'fresh' }
	| { readonly kind: 'refuse'; readonly reason: RecreateReason };

export type RecreateReason =
	| 'image-mismatch'
	| 'config-mismatch'
	| 'unclean-shutdown'
	| 'resume-failed';

/** Pure decision: given the inspect facts (or null = missing), the
 *  desired image + host port bindings, and the policy, what action
 *  do we take?
 *
 *  Tested directly without the subprocess seam. */
export const decideRunAction = (
	facts: InspectFacts | null,
	desiredImage: string,
	policy: RecreatePolicy,
	desiredPortBindings: ReadonlyArray<string> = [],
	portBindingReconciliation: PortBindingReconciliation = 'exact',
): RunAction => {
	if (facts === null) return { kind: 'fresh' };
	const imageMatches = facts.image === desiredImage;
	const portsMatch = sameBindings(facts.portBindings ?? [], desiredPortBindings);
	const portsCompatible =
		portsMatch ||
		(portBindingReconciliation === 'adopt-existing' &&
			sameBindingContainerPorts(facts.portBindings ?? [], desiredPortBindings));
	if (facts.paused) {
		return imageMatches && portsCompatible
			? { kind: 'unpause-adopt', id: facts.id }
			: routeRecreate(
					{
						kind: 'recreate',
						id: facts.id,
						reason: imageMatches ? 'config-mismatch' : 'image-mismatch',
					},
					policy,
				);
	}
	if (facts.running) {
		return imageMatches && portsCompatible
			? { kind: 'adopt', id: facts.id }
			: routeRecreate(
					{
						kind: 'recreate',
						id: facts.id,
						reason: imageMatches ? 'config-mismatch' : 'image-mismatch',
					},
					policy,
				);
	}
	// Stopped
	if (!imageMatches) {
		// Image mismatch ALWAYS wins (architecture §11).
		return routeRecreate({ kind: 'recreate', id: facts.id, reason: 'image-mismatch' }, policy);
	}
	if (!portsCompatible) {
		return routeRecreate({ kind: 'recreate', id: facts.id, reason: 'config-mismatch' }, policy);
	}
	if (facts.exitCode === 137) {
		// Unclean shutdown — see architecture §G1 / §13.
		// `on-failure`: recreate. `never`: refuse. `on-config-change`:
		// resume — caller wants stopped container kept until config
		// changes, even if the prior exit was unclean.
		if (policy === 'on-failure') {
			return { kind: 'recreate', id: facts.id, reason: 'unclean-shutdown' };
		}
		if (policy === 'never') {
			return { kind: 'refuse', reason: 'unclean-shutdown' };
		}
		return { kind: 'resume', id: facts.id };
	}
	return { kind: 'resume', id: facts.id };
};

/** Route a recreate-class decision through the policy. */
const routeRecreate = (
	action: RunAction & { kind: 'recreate' },
	policy: RecreatePolicy,
): RunAction => {
	if (policy === 'never') return { kind: 'refuse', reason: action.reason };
	return action;
};

const canonicalPortBindings = (
	ports: ReadonlyArray<ContainerPortPublish> | undefined,
): ReadonlyArray<string> =>
	[...(ports ?? [])]
		.map((p) => `${p.containerPort}/tcp=${normalizeHostIp(p.hostIp)}:${p.hostPort}`)
		.sort();

const sameBindings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const sameBindingContainerPorts = (
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
): boolean => {
	const leftContainers = left.map(bindingContainerKey).sort();
	const rightContainers = right.map(bindingContainerKey).sort();
	return sameBindings(leftContainers, rightContainers);
};

const bindingContainerKey = (binding: string): string => binding.split('=')[0] ?? binding;

const normalizeHostIp = (hostIp: string | undefined): string =>
	hostIp === undefined || hostIp === '' ? '0.0.0.0' : hostIp;

const readPublishedPorts = (raw: unknown): ReadonlyArray<ContainerPortPublish> => {
	if (raw === null || typeof raw !== 'object') return [];
	const out: ContainerPortPublish[] = [];
	for (const [container, bindings] of Object.entries(raw)) {
		const containerPort = Number(container.split('/')[0]);
		if (!Number.isInteger(containerPort) || containerPort <= 0) continue;
		if (!Array.isArray(bindings)) continue;
		for (const binding of bindings) {
			if (binding === null || typeof binding !== 'object') continue;
			const hostPort = (binding as { HostPort?: unknown }).HostPort;
			if (typeof hostPort !== 'string') continue;
			const hostPortNumber = Number(hostPort);
			if (!Number.isInteger(hostPortNumber) || hostPortNumber <= 0) continue;
			const hostIp = (binding as { HostIp?: unknown }).HostIp;
			out.push({
				containerPort,
				hostPort: hostPortNumber,
				...(typeof hostIp === 'string' ? { hostIp: normalizeHostIp(hostIp) } : {}),
			});
		}
	}
	return out.sort((a, b) => {
		if (a.containerPort !== b.containerPort) return a.containerPort - b.containerPort;
		const hostIp = normalizeHostIp(a.hostIp).localeCompare(normalizeHostIp(b.hostIp));
		return hostIp !== 0 ? hostIp : a.hostPort - b.hostPort;
	});
};

const readMounts = (raw: unknown): ReadonlyArray<InspectMount> => {
	if (!Array.isArray(raw)) return [];
	const out: InspectMount[] = [];
	for (const mount of raw) {
		if (mount === null || typeof mount !== 'object') continue;
		const source = (mount as { Source?: unknown }).Source;
		const target = (mount as { Destination?: unknown }).Destination;
		if (typeof source !== 'string' || typeof target !== 'string') continue;
		const rw = (mount as { RW?: unknown }).RW;
		out.push({
			source,
			target,
			...(typeof rw === 'boolean' ? { readOnly: !rw } : {}),
		});
	}
	return out;
};

const readStringArray = (raw: unknown): ReadonlyArray<string> => {
	if (!Array.isArray(raw)) return [];
	return raw.filter((value): value is string => typeof value === 'string');
};

const readLabels = (raw: unknown): Readonly<Record<string, string>> => {
	if (raw === null || typeof raw !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
};

const readNetworks = (raw: unknown): ReadonlyArray<string> => {
	if (raw === null || typeof raw !== 'object') return [];
	return Object.keys(raw).sort();
};

// -----------------------------------------------------------------------------
// Inspect — `docker inspect <name>`
// -----------------------------------------------------------------------------

const InspectSchema = Schema.Struct({
	Id: Schema.String,
	Image: Schema.String,
	Mounts: Schema.optional(Schema.Unknown),
	HostConfig: Schema.Struct({
		PortBindings: Schema.Unknown,
	}),
	State: Schema.Struct({
		Running: Schema.Boolean,
		Paused: Schema.Boolean,
		ExitCode: Schema.Number,
	}),
	Config: Schema.Struct({
		Image: Schema.String,
		Cmd: Schema.optional(Schema.Unknown),
		Labels: Schema.optional(Schema.Unknown),
	}),
	NetworkSettings: Schema.Struct({
		Networks: Schema.Unknown,
		Ports: Schema.optional(Schema.Unknown),
	}),
});

export const inspectContainer = (
	name: string,
): Effect.Effect<InspectFacts | null, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('inspect', [name]).pipe(
			Effect.mapError(wrapGeneric('docker.inspect')),
		);
		if (res.exitCode !== 0) {
			if (isNoSuchContainerStderr(res.stderr)) return null;
			if (isDaemonUnreachableStderr(res.stderr)) {
				return yield* Effect.fail(
					new DaemonUnreachable({
						op: 'docker.inspect',
						detail: 'docker daemon unreachable',
					}),
				);
			}
			return yield* Effect.fail(
				new DockerInspectFailed({
					resource: 'container',
					name,
					stderr: res.stderr,
					exitCode: res.exitCode,
				}),
			);
		}
		try {
			const arr = JSON.parse(res.stdout) as unknown;
			if (!Array.isArray(arr) || arr.length === 0) {
				return yield* Effect.fail(
					new DockerInspectDecodeFailed({
						resource: 'container',
						name,
						detail: 'inspect returned an empty result',
					}),
				);
			}
			const decoded = Schema.decodeUnknownSync(InspectSchema)(arr[0]);
			const ports = readPublishedPorts(decoded.HostConfig.PortBindings);
			const effectivePorts = readPublishedPorts(decoded.NetworkSettings.Ports);
			const mounts = readMounts(decoded.Mounts);
			const command = readStringArray(decoded.Config.Cmd);
			const labels = readLabels(decoded.Config.Labels);
			const networks = readNetworks(decoded.NetworkSettings.Networks);
			return {
				id: decoded.Id,
				running: decoded.State.Running,
				paused: decoded.State.Paused,
				exitCode: decoded.State.ExitCode,
				// The container's recorded image — `Config.Image` is the
				// resolved-at-create image ref. The runtime's `Image`
				// field is the digest; either works for the comparison.
				image: decoded.Config.Image,
				mounts,
				portBindings: canonicalPortBindings(ports),
				ports,
				effectivePortBindings: canonicalPortBindings(effectivePorts),
				effectivePorts,
				command,
				labels,
				networks,
			};
		} catch (cause) {
			return yield* Effect.fail(
				new DockerInspectDecodeFailed({
					resource: 'container',
					name,
					detail: 'inspect returned malformed container JSON',
					cause,
				}),
			);
		}
	}).pipe(Effect.withSpan('runtime.docker.container.inspect'));

// -----------------------------------------------------------------------------
// Argv construction
// -----------------------------------------------------------------------------

const createArgv = (
	spec: EnsureContainerSpec,
	cycle: number,
	imageRef: string,
): ReadonlyArray<string> => {
	const args: Array<string> = ['-d', '--name', spec.name];
	for (const label of renderContainerLabels(spec.labels, cycle)) {
		args.push('--label', label);
	}
	if (spec.env) {
		for (const [k, v] of Object.entries(spec.env)) {
			args.push('--env', `${k}=${v}`);
		}
	}
	if (spec.ports) {
		for (const p of spec.ports) {
			const hostPrefix = p.hostIp === undefined ? '' : `${p.hostIp}:`;
			args.push('-p', `${hostPrefix}${p.hostPort}:${p.containerPort}`);
		}
	}
	if (spec.mounts) {
		for (const m of spec.mounts) {
			const ro = m.readonly ? ',readonly' : '';
			args.push('--mount', `type=bind,source=${m.source},target=${m.target}${ro}`);
		}
	}
	if (spec.networkAttach && spec.networkAttach.length > 0) {
		// First attach goes via --network; subsequent attaches via
		// post-start `network connect` so we can wait for IP readback.
		args.push('--network', spec.networkAttach[0]!);
	}
	if (spec.extraHosts) {
		for (const [host, ip] of Object.entries(spec.extraHosts)) {
			args.push('--add-host', `${host}:${ip}`);
		}
	}
	if (spec.entrypoint) {
		args.push('--entrypoint', spec.entrypoint);
	}
	args.push(imageRef);
	if (spec.command) {
		args.push(...spec.command);
	}
	return args;
};

// -----------------------------------------------------------------------------
// Apply the state machine
// -----------------------------------------------------------------------------

const handleOf = (
	id: string,
	name: string,
	imageName: string,
	status: ContainerHandle['status'],
	ips: ReadonlyArray<string>,
	ports?: ReadonlyArray<ContainerPortPublish>,
	labels?: EnsureContainerSpec['labels'],
): ContainerHandle => ({
	id,
	name,
	...(labels !== undefined ? { labels } : {}),
	imageName,
	status,
	ips,
	...(ports !== undefined ? { ports } : {}),
});

/** Force-remove by name. Used by recreate. Idempotent on
 *  "no such container". */
const forceRemove = (
	name: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('rm', ['-f', name]).pipe(
			Effect.mapError(wrapGeneric('docker.rm')),
		);
		if (res.exitCode !== 0 && !isNoSuchContainerStderr(res.stderr)) {
			// best-effort; we surface as a span event but do not fail
			// the rm step (the next create will collision-recover).
			yield* Effect.annotateCurrentSpan({ 'docker.rm.warning': res.stderr });
		}
	}).pipe(Effect.withSpan('runtime.docker.container.forceRemove'));

const ownershipFailure = (
	name: string,
	expected: Readonly<Record<string, string>>,
	actual: Readonly<Record<string, string>>,
	detail: string,
): ForeignDockerResource =>
	new ForeignDockerResource({
		resource: 'container',
		name,
		expected,
		actual,
		detail,
	});

const assertOwnedFacts = (
	name: string,
	facts: InspectFacts,
	labels: EnsureContainerSpec['labels'],
): Effect.Effect<void, DockerRuntimeError> =>
	Effect.gen(function* () {
		const expected = expectedContainerOwnershipLabels(labels);
		const actual = facts.labels ?? {};
		const mismatch = ownershipMismatchDetail(expected, actual);
		if (mismatch !== null) {
			return yield* Effect.fail(ownershipFailure(name, expected, actual, mismatch));
		}
	});

export const assertContainerHandleOwned = (
	handle: ContainerHandle,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		if (handle.labels === undefined) {
			return yield* Effect.fail(
				ownershipFailure(handle.name, {}, {}, 'container handle has no ownership labels'),
			);
		}
		const facts = yield* inspectContainer(handle.name);
		const expected = expectedContainerOwnershipLabels(handle.labels);
		if (facts === null) {
			return yield* Effect.fail(
				ownershipFailure(handle.name, expected, {}, 'container is missing'),
			);
		}
		if (facts.id !== handle.id) {
			return yield* Effect.fail(
				ownershipFailure(handle.name, expected, facts.labels ?? {}, `id changed to ${facts.id}`),
			);
		}
		yield* assertOwnedFacts(handle.name, facts, handle.labels);
	}).pipe(Effect.withSpan('runtime.docker.container.assertOwned'));

const forceRemoveOwned = (
	name: string,
	id: string,
	labels: EnsureContainerSpec['labels'],
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const current = yield* inspectContainer(name);
		if (current === null) return;
		if (current.id !== id) {
			const expected = expectedContainerOwnershipLabels(labels);
			return yield* Effect.fail(
				ownershipFailure(name, expected, current.labels ?? {}, `id changed to ${current.id}`),
			);
		}
		yield* assertOwnedFacts(name, current, labels);
		yield* forceRemove(name);
	});

/** Single-shot start-and-adopt fallback after `docker create` exit-125
 *  with name-collision. Architecture §1 / G10 — one attempt; second
 *  collision is a typed failure. */
const startAndAdopt = (
	name: string,
	labels: EnsureContainerSpec['labels'],
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const beforeStart = yield* inspectContainer(name);
		if (beforeStart === null) {
			return yield* Effect.fail(
				new ContainerNameCollisionUnrecoverable({
					name,
					detail: 'name collision but inspect found no container',
				}),
			);
		}
		yield* assertOwnedFacts(name, beforeStart, labels);
		const res = yield* dockerRunOk('start', [name]).pipe(
			Effect.mapError(wrapGeneric('docker.start')),
		);
		const cls = classifyExit(res);
		if (cls.ok) {
			const facts = yield* inspectContainer(name);
			if (facts === null) {
				return yield* Effect.fail(
					new ContainerNameCollisionUnrecoverable({
						name,
						detail: 'peer collision + start succeeded + inspect missed',
					}),
				);
			}
			yield* assertOwnedFacts(name, facts, labels);
			return facts.id;
		}
		if (isNoSuchContainerStderr(cls.stderr)) {
			// Peer rm'd between our collision and the start. The caller's
			// outer loop will see this as "missing" and promote to fresh.
			return yield* Effect.fail(
				new ContainerNameCollisionUnrecoverable({
					name,
					detail: 'TOCTOU: start after collision found no container',
				}),
			);
		}
		return yield* Effect.fail(
			new ContainerNameCollisionUnrecoverable({
				name,
				detail: `start-and-adopt failed: ${cls.stderr}`,
			}),
		);
	});

const freshCreate = (
	spec: EnsureContainerSpec,
	cycle: number,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const args = createArgv(spec, cycle, spec.image.tag ?? spec.image.digest);
		const created = yield* dockerRun('run', args).pipe(Effect.mapError(wrapCreateError(spec.name)));
		return created.stdout.trim();
	});

const resumeStart = (
	name: string,
): Effect.Effect<
	{ readonly ok: true } | { readonly ok: false; readonly stderr: string },
	DockerRuntimeError,
	DockerHost | DockerSpawner
> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('start', [name]).pipe(
			Effect.mapError(wrapGeneric('docker.start')),
		);
		if (res.exitCode === 0) return { ok: true as const };
		if (isDaemonUnreachableStderr(res.stderr)) {
			return yield* Effect.fail(
				new DaemonUnreachable({
					op: 'docker.start',
					detail: 'docker daemon unreachable',
				}),
			);
		}
		return { ok: false as const, stderr: res.stderr };
	});

const recreateAfterResumeFailure = (
	id: string,
	spec: EnsureContainerSpec,
	deps: EnsureContainerDeps,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const routed = routeRecreate({ kind: 'recreate', id, reason: 'resume-failed' }, spec.recreate);
		if (routed.kind === 'refuse') {
			return yield* Effect.fail(new RecreateRefused({ name: spec.name, reason: routed.reason }));
		}
		yield* forceRemoveOwned(spec.name, id, spec.labels);
		return yield* createWithCollisionRecovery(spec, deps);
	});

const effectivePortsCompatible = (facts: InspectFacts, spec: EnsureContainerSpec): boolean => {
	const desired = canonicalPortBindings(spec.ports);
	if (desired.length === 0) return true;
	const actual = facts.effectivePortBindings ?? [];
	if (sameBindings(actual, desired)) return true;
	return (
		(spec.portBindingReconciliation ?? 'exact') === 'adopt-existing' &&
		sameBindingContainerPorts(actual, desired)
	);
};

const ensureEffectivePublishedPorts = (
	id: string,
	spec: EnsureContainerSpec,
	deps: EnsureContainerDeps,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		if ((spec.ports ?? []).length === 0) return id;
		const facts = yield* inspectContainer(spec.name);
		if (facts === null || facts.id !== id || !facts.running) return id;
		yield* assertOwnedFacts(spec.name, facts, spec.labels);
		if (effectivePortsCompatible(facts, spec)) return id;
		const repairedId = yield* recreateAfterResumeFailure(id, spec, deps);
		const repairedFacts = yield* inspectContainer(spec.name);
		if (
			repairedFacts !== null &&
			repairedFacts.id === repairedId &&
			repairedFacts.running &&
			effectivePortsCompatible(repairedFacts, spec)
		) {
			return repairedId;
		}
		return yield* Effect.fail(
			new ContainerCreateFailed({
				name: spec.name,
				stderr: `container is running but Docker did not publish requested ports: desired=${JSON.stringify(
					canonicalPortBindings(spec.ports),
				)} actual=${JSON.stringify(repairedFacts?.effectivePortBindings ?? [])}`,
				exitCode: 0,
			}),
		);
	});

const stopWithGrace = (
	name: string,
	graceSeconds: number,
	signal?: string,
): Effect.Effect<void, never, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const args: Array<string> = [];
		if (signal !== undefined) args.push('--signal', signal);
		args.push('--time', String(Math.max(0, Math.floor(graceSeconds))));
		args.push(name);
		yield* dockerRunOk('stop', args).pipe(
			Effect.catch(() => Effect.void),
			Effect.asVoid,
		);
	});

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

/** Per-name lock state. Map entry present = name is held; the value is
 *  the FIFO queue of waiter deferreds. Empty queue = held with no
 *  waiters. Map entry absent = free. */
export type PerNameLockState = ReadonlyMap<string, ReadonlyArray<Deferred.Deferred<void>>>;

export interface EnsureContainerDeps {
	/** Current engine cycle id; stamped as the `devstack.cycle` label. */
	readonly cycle: number;
	/** Process-local lock holder to serialize per-name actions within
	 *  one Node process. Cross-process safety is the docker daemon's
	 *  `--name` atomicity. */
	readonly perNameLock: Ref.Ref<PerNameLockState>;
}

/** Per-name lock acquire/release. The in-process serialization is the
 *  inspect→action window's invariant: two concurrent ensureContainer
 *  calls for the same name must not race between the read (inspect)
 *  and the write (create / start / recreate). Cross-process safety is
 *  separately the docker daemon's `--name` atomicity.
 *
 *  Implementation: a `Ref<Map<name, Deferred[]>>`. Acquire atomically
 *  claims the slot (free → enter with empty queue) or enqueues a fresh
 *  Deferred at the tail and awaits it. Release pops the head of the
 *  queue and completes that waiter — transferring ownership without a
 *  free intermediate window. Empty-queue release deletes the entry.
 *  No wall-clock polling: contention parks fibers on Deferred.await
 *  rather than spinning, so tests can use `it.effect` (TestClock) and
 *  contended-acquire ordering is FIFO by construction.
 *
 *  Exported for direct testing. */
export const acquirePerNameLock = (
	lock: Ref.Ref<PerNameLockState>,
	name: string,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const waiter = yield* Deferred.make<void>();
		const claimed = yield* Ref.modify(lock, (m) => {
			const queue = m.get(name);
			const next = new Map(m);
			if (queue === undefined) {
				// Free → claim with empty waiter queue.
				next.set(name, []);
				return [true, next as PerNameLockState] as const;
			}
			// Held → enqueue and await.
			next.set(name, [...queue, waiter]);
			return [false, next as PerNameLockState] as const;
		});
		if (claimed) return;
		// Park until the current holder releases and completes our
		// deferred. Interrupt-cleanup: if we're interrupted while
		// queued, drop our deferred from the queue so a future
		// release doesn't transfer ownership to a dead waiter.
		yield* Deferred.await(waiter).pipe(
			Effect.onInterrupt(() =>
				Ref.update(lock, (m) => {
					const queue = m.get(name);
					if (queue === undefined) return m;
					const filtered = queue.filter((d) => d !== waiter);
					if (filtered.length === queue.length) return m;
					const next = new Map(m);
					next.set(name, filtered);
					return next as PerNameLockState;
				}),
			),
		);
	});

export const releasePerNameLock = (
	lock: Ref.Ref<PerNameLockState>,
	name: string,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const head = yield* Ref.modify(lock, (m) => {
			const queue = m.get(name);
			if (queue === undefined) return [undefined, m] as const;
			const next = new Map(m);
			if (queue.length === 0) {
				next.delete(name);
				return [undefined, next as PerNameLockState] as const;
			}
			const [first, ...rest] = queue;
			next.set(name, rest);
			return [first, next as PerNameLockState] as const;
		});
		if (head !== undefined) {
			yield* Deferred.succeed(head, undefined);
		}
	});

/** Idempotent ensure: apply the state machine, register a scope
 *  finalizer that stops the container + releases the cross-process
 *  claim.
 *
 *  Returns the running container handle (id + name + status + ips). */
export const ensureContainer = (
	spec: EnsureContainerSpec,
	deps: EnsureContainerDeps,
): Effect.Effect<
	ContainerHandle,
	DockerRuntimeError,
	DockerHost | DockerSpawner | StackPathsService | Scope.Scope
> =>
	Effect.gen(function* () {
		// Per-name lock holds the inspect → applyAction window. We release
		// immediately after applyAction returns (success or typed failure)
		// so concurrent callers for the SAME name serialize at the
		// "decide what to do" step, but the lock does not outlive the
		// state-machine resolution. `acquireUseRelease` ensures the
		// release fires on interrupt/defect too.
		const desiredImageRef = spec.image.tag ?? spec.image.digest;
		const id = yield* Effect.acquireUseRelease(
			acquirePerNameLock(deps.perNameLock, spec.name),
			() =>
				Effect.gen(function* () {
					const facts = yield* inspectContainer(spec.name);
					if (facts !== null) {
						yield* assertOwnedFacts(spec.name, facts, spec.labels);
					}
					const action = decideRunAction(
						facts,
						desiredImageRef,
						spec.recreate,
						canonicalPortBindings(spec.ports),
						spec.portBindingReconciliation ?? 'exact',
					);
					const id = yield* applyAction(action, spec, deps);
					return yield* ensureEffectivePublishedPorts(id, spec, deps);
				}),
			() => releasePerNameLock(deps.perNameLock, spec.name),
		);
		yield* assertContainerHandleOwned({
			id,
			name: spec.name,
			labels: spec.labels,
			imageName: spec.image.tag ?? spec.image.digest,
			status: 'running',
			ips: [],
		});

		// Architecture §5 — secondary network attaches (any beyond the
		// first, which is wired in via `--network` on create) must wait
		// for IP allocation before we declare ready.
		const secondaries = (spec.networkAttach ?? []).slice(1);
		for (const net of secondaries) {
			yield* connect(spec.name, net);
			yield* waitForIp(spec.name, net);
		}

		const ips = yield* readIps(spec.name);
		const refreshedFacts = yield* inspectContainer(spec.name);
		const ports = refreshedFacts?.effectivePorts ?? refreshedFacts?.ports ?? spec.ports;

		// Register cross-process claim and scope-bound release. The
		// stop finalizer fires on scope close if the same container id
		// still owns the stable name. Restore may deliberately remove a
		// claimed container and a later acquire may reuse the name before
		// this scope closes; the old finalizer must not stop that newer
		// container. Architecture §13: stop is uninterruptible.
		const paths = yield* StackPathsService;
		const mapSubstrateError = (cause: unknown): DockerRuntimeError =>
			new DaemonUnreachable({
				op: 'cross-process.claim',
				detail: `cross-process claim mutation failed: ${String(cause)}`,
				cause,
			});
		yield* addClaim(
			{ stackLockFile: paths.stackLockFile, rosterFile: paths.rosterFile },
			spec.name,
		).pipe(Effect.mapError(mapSubstrateError));

		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const current = yield* inspectContainer(spec.name).pipe(
					Effect.catch(() => Effect.succeed(null)),
				);
				if (current?.id === id) {
					yield* stopWithGrace(spec.name, 10);
				}
				yield* removeClaim(
					{ stackLockFile: paths.stackLockFile, rosterFile: paths.rosterFile },
					spec.name,
				).pipe(Effect.catch(() => Effect.succeed({ lastClaimReleased: false })));
			}).pipe(Effect.uninterruptible),
		);

		return handleOf(
			id,
			spec.name,
			spec.image.tag ?? spec.image.digest,
			'running',
			ips,
			ports,
			spec.labels,
		);
	}).pipe(Effect.withSpan('runtime.docker.container.ensure'));

/** Apply the decided action. Recovers from name-collision via
 *  one-shot start-and-adopt; second collision surfaces typed. */
const applyAction = (
	action: RunAction,
	spec: EnsureContainerSpec,
	deps: EnsureContainerDeps,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner | Scope.Scope> =>
	Effect.gen(function* () {
		switch (action.kind) {
			case 'adopt':
				return action.id;
			case 'unpause-adopt':
				yield* assertContainerHandleOwned({
					id: action.id,
					name: spec.name,
					labels: spec.labels,
					imageName: spec.image.tag ?? spec.image.digest,
					status: 'paused',
					ips: [],
				});
				yield* unpause(spec.name);
				return action.id;
			case 'resume': {
				yield* assertContainerHandleOwned({
					id: action.id,
					name: spec.name,
					labels: spec.labels,
					imageName: spec.image.tag ?? spec.image.digest,
					status: 'exited',
					ips: [],
				});
				const started = yield* resumeStart(spec.name);
				if (!started.ok) {
					return yield* recreateAfterResumeFailure(action.id, spec, deps);
				}
				return action.id;
			}
			case 'recreate': {
				yield* forceRemoveOwned(spec.name, action.id, spec.labels);
				return yield* createWithCollisionRecovery(spec, deps);
			}
			case 'fresh':
				return yield* createWithCollisionRecovery(spec, deps);
			case 'refuse':
				return yield* Effect.fail(new RecreateRefused({ name: spec.name, reason: action.reason }));
		}
	});

/** `docker run -d` with single-shot start-and-adopt fallback on
 *  name-collision. */
const createWithCollisionRecovery = (
	spec: EnsureContainerSpec,
	deps: EnsureContainerDeps,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	freshCreate(spec, deps.cycle).pipe(
		Effect.catchTag('ContainerNameCollisionUnrecoverable', () =>
			startAndAdopt(spec.name, spec.labels),
		),
		// If the original create surfaced a typed `ContainerCreateFailed`
		// where stderr was name-collision (sometimes the create variant
		// surfaces with that), attempt the same start-and-adopt.
		Effect.catchTag('ContainerCreateFailed', (err) =>
			isNameCollisionStderr(err.stderr) ? startAndAdopt(spec.name, spec.labels) : Effect.fail(err),
		),
	);

// -----------------------------------------------------------------------------
// Stop / commit / pause — used by the snapshot orchestrator
// -----------------------------------------------------------------------------

export const stop = (
	name: string,
	graceSeconds: number,
	signal?: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	stopWithGrace(name, graceSeconds, signal).pipe(Effect.asVoid);

export const pause = (
	name: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		yield* dockerRun('pause', [name]).pipe(Effect.mapError(wrapGeneric('docker.pause')));
	}).pipe(Effect.withSpan('runtime.docker.container.pause'));

export const unpause = (
	name: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		yield* dockerRun('unpause', [name]).pipe(Effect.mapError(wrapGeneric('docker.unpause')));
	}).pipe(Effect.withSpan('runtime.docker.container.unpause'));

/** `docker commit <name> <tag>` — writable layer → image. Used by
 *  snapshot capture. */
export const commit = (
	name: string,
	tag: string,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRun('commit', [name, tag]).pipe(
			Effect.mapError(wrapGeneric('docker.commit')),
		);
		const digest = res.stdout.trim();
		if (digest.length === 0) {
			return yield* Effect.fail(
				new ContainerCreateFailed({
					name,
					stderr: 'commit returned empty digest',
					exitCode: 0,
				}),
			);
		}
		return digest;
	}).pipe(Effect.withSpan('runtime.docker.container.commit'));
