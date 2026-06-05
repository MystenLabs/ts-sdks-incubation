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
//   §2  Label-driven inventory — we use `docker container inspect <name>`
//       for the single-container probe path (cheaper than label-filtered
//       `ps`, and type-specific when container/network names collide), but
//       the labels are still STAMPED on create so sweep can find us by
//       labels later.
//   §5  Async network-connect — `network.ts::waitForIp` is called
//       after attach and before we declare ready.
//   §9  RecreatePolicy enum routed in — `never` refuses to recreate;
//       `on-failure` recreates on unclean shutdown + image mismatch;
//       `on-config-change` recreates on image mismatch, port mismatch,
//       or caller-supplied config hash mismatch.

import { Deferred, Effect, Ref, Scope, Schema } from 'effect';

import type {
	ContainerHandle,
	ContainerPortPublish,
	EnsureContainerSpec,
	NetworkAttachment,
	PortBindingReconciliation,
	RecreatePolicy,
} from '../../contracts/container-runtime.ts';
import { recordRuntimeInvalidation } from '../../substrate/runtime/invalidation-tracker.ts';
import { DockerHost, DockerSpawner, dockerRun, dockerRunOk } from './client.ts';
import {
	ContainerCreateFailed,
	ContainerNameCollisionUnrecoverable,
	DaemonUnreachable,
	type DockerRuntimeError,
	ForeignDockerResource,
	ImageNotFound,
	RecreateRefused,
} from './errors.ts';
import { dockerInspectAndDecode } from './inspect-and-decode.ts';
import {
	expectedContainerOwnershipLabels,
	LabelKey,
	ownershipMismatchDetail,
	readLabels,
	renderContainerLabels,
} from './labels.ts';
import { connect, readIps, waitForIp } from './network.ts';
import { renderCreateArgs } from './render-run-args.ts';
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

export type InspectLifecycleState =
	| { readonly kind: 'running'; readonly exitCode: number }
	| { readonly kind: 'paused'; readonly exitCode: number }
	| { readonly kind: 'stopped'; readonly exitCode: number }
	| { readonly kind: 'unknown' };

/** What `docker container inspect <name>` told us. Lifecycle facts are explicit:
 *  Docker may omit `State`, and absence means we cannot prove running,
 *  paused, or stopped state. */
export interface InspectFacts {
	readonly id: string;
	readonly lifecycle: InspectLifecycleState;
	readonly running: boolean;
	readonly paused: boolean;
	readonly exitCode: number | null;
	/** Create-time image ref recorded by Docker. For tagged builds this is
	 *  usually the tag passed to `docker run`. */
	readonly image: string;
	/** Resolved image id from Docker inspect's top-level `Image` field. */
	readonly imageDigest?: string;
	readonly mounts?: ReadonlyArray<InspectMount>;
	readonly portBindings?: ReadonlyArray<string>;
	readonly ports?: ReadonlyArray<ContainerPortPublish>;
	readonly effectivePortBindings?: ReadonlyArray<string>;
	readonly effectivePorts?: ReadonlyArray<ContainerPortPublish>;
	readonly command?: ReadonlyArray<string>;
	readonly labels?: Readonly<Record<string, string>>;
	readonly networks?: ReadonlyArray<string>;
	readonly networkAttachments?: ReadonlyArray<InspectNetworkAttachment>;
}

export interface InspectMount {
	readonly source: string;
	readonly target: string;
	readonly readOnly?: boolean;
}

export interface InspectNetworkAttachment {
	readonly name: string;
	readonly aliases: ReadonlyArray<string>;
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
	| 'resume-failed'
	| 'unknown-state';

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
	desiredConfigHash?: string,
	desiredImageDigest?: string,
	desiredNetworkAttachments: ReadonlyArray<string | NetworkAttachment> = [],
): RunAction => {
	if (facts === null) return { kind: 'fresh' };
	const imageMatches =
		facts.image === desiredImage ||
		(desiredImageDigest !== undefined &&
			(facts.image === desiredImageDigest || facts.imageDigest === desiredImageDigest));
	const portsMatch = sameBindings(facts.portBindings ?? [], desiredPortBindings);
	const portsCompatible =
		portsMatch ||
		(portBindingReconciliation === 'adopt-existing' &&
			sameBindingContainerPorts(facts.portBindings ?? [], desiredPortBindings));
	const networksCompatible = desiredNetworkAttachmentsCompatible(
		facts.networkAttachments ?? [],
		desiredNetworkAttachments,
	);
	const configMatches =
		networksCompatible &&
		(desiredConfigHash === undefined || facts.labels?.[LabelKey.configHash] === desiredConfigHash);
	if (facts.lifecycle.kind === 'unknown') {
		return routeRecreate({ kind: 'recreate', id: facts.id, reason: 'unknown-state' }, policy);
	}
	if (facts.lifecycle.kind === 'paused') {
		return imageMatches && portsCompatible && configMatches
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
	if (facts.lifecycle.kind === 'running') {
		return imageMatches && portsCompatible && configMatches
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
	if (!imageMatches) {
		// Image mismatch ALWAYS wins (architecture §11).
		return routeRecreate({ kind: 'recreate', id: facts.id, reason: 'image-mismatch' }, policy);
	}
	if (!portsCompatible) {
		return routeRecreate({ kind: 'recreate', id: facts.id, reason: 'config-mismatch' }, policy);
	}
	if (!configMatches) {
		return routeRecreate({ kind: 'recreate', id: facts.id, reason: 'config-mismatch' }, policy);
	}
	// The only unclean exit the engine acts on is SIGKILL/137 (the
	// unclean-shutdown signal, architecture §G1 / §13). `on-failure`:
	// recreate. `never`: refuse. `on-config-change`: resume. Every other
	// exit — clean (0/130) or any other non-137 code — falls through to
	// resume its persisted writable layer (no recreate signal).
	if (facts.lifecycle.exitCode === 137) {
		if (policy === 'on-failure') {
			return { kind: 'recreate', id: facts.id, reason: 'unclean-shutdown' };
		}
		if (policy === 'never') {
			return { kind: 'refuse', reason: 'unclean-shutdown' };
		}
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

const desiredNetworkAttachmentsCompatible = (
	actual: ReadonlyArray<InspectNetworkAttachment>,
	desired: ReadonlyArray<string | NetworkAttachment>,
): boolean => {
	const actualByName = new Map(actual.map((network) => [network.name, network]));
	return desired.every((entry, index) => {
		const normalized = normalizeNetworkAttachment(entry);
		const actualNetwork = actualByName.get(normalized.name);
		if (actualNetwork === undefined) {
			return index !== 0;
		}
		if (normalized.aliases === undefined || normalized.aliases.length === 0) return true;
		const actualAliases = new Set(actualNetwork.aliases);
		return normalized.aliases.every((alias) => actualAliases.has(alias));
	});
};

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

const readNetworks = (raw: unknown): ReadonlyArray<string> => {
	if (raw === null || typeof raw !== 'object') return [];
	return Object.keys(raw).sort();
};

const readNetworkAttachments = (raw: unknown): ReadonlyArray<InspectNetworkAttachment> => {
	if (raw === null || typeof raw !== 'object') return [];
	return Object.entries(raw)
		.map(([name, value]): InspectNetworkAttachment => {
			const aliases =
				value !== null && typeof value === 'object'
					? ((value as { Aliases?: unknown }).Aliases ?? [])
					: [];
			return {
				name,
				aliases: Array.isArray(aliases)
					? aliases.filter((alias): alias is string => typeof alias === 'string').sort()
					: [],
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
};

const readLifecycleState = (
	state:
		| {
				readonly Running: boolean;
				readonly Paused: boolean;
				readonly ExitCode: number;
		  }
		| undefined,
): InspectLifecycleState => {
	if (state === undefined) return { kind: 'unknown' };
	if (state.Paused) return { kind: 'paused', exitCode: state.ExitCode };
	if (state.Running) return { kind: 'running', exitCode: state.ExitCode };
	return { kind: 'stopped', exitCode: state.ExitCode };
};

// -----------------------------------------------------------------------------
// Inspect — `docker container inspect <name>`
// -----------------------------------------------------------------------------

const InspectSchema = Schema.Struct({
	Id: Schema.String,
	Image: Schema.optional(Schema.String),
	Mounts: Schema.optional(Schema.Unknown),
	HostConfig: Schema.optional(
		Schema.Struct({
			PortBindings: Schema.Unknown,
		}),
	),
	State: Schema.optional(
		Schema.Struct({
			Running: Schema.Boolean,
			Paused: Schema.Boolean,
			ExitCode: Schema.Number,
		}),
	),
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
		const decoded = yield* dockerInspectAndDecode({
			resourceKind: 'container',
			name,
			op: 'docker.container.inspect',
			inspectCommand: dockerRunOk('container', ['inspect', name]).pipe(
				Effect.mapError(wrapGeneric('docker.container.inspect')),
			),
			schema: InspectSchema,
			isMissingStderr: isNoSuchContainerStderr,
		});
		if (decoded === null) return null;
		const lifecycle = readLifecycleState(decoded.State);
		const effectivePorts = readPublishedPorts(decoded.NetworkSettings.Ports);
		const ports =
			decoded.HostConfig === undefined
				? effectivePorts
				: readPublishedPorts(decoded.HostConfig.PortBindings);
		const mounts = readMounts(decoded.Mounts);
		const command = readStringArray(decoded.Config.Cmd);
		const labels = readLabels(decoded.Config.Labels);
		const networks = readNetworks(decoded.NetworkSettings.Networks);
		const networkAttachments = readNetworkAttachments(decoded.NetworkSettings.Networks);
		return {
			id: decoded.Id,
			lifecycle,
			running: lifecycle.kind === 'running' || lifecycle.kind === 'paused',
			paused: lifecycle.kind === 'paused',
			exitCode: lifecycle.kind === 'unknown' ? null : lifecycle.exitCode,
			// The container's recorded image. Docker may omit the
			// top-level digest field, but lifecycle decisions need the
			// create-time ref from Config.Image.
			image: decoded.Config.Image,
			...(decoded.Image !== undefined ? { imageDigest: decoded.Image } : {}),
			mounts,
			portBindings: canonicalPortBindings(ports),
			ports,
			effectivePortBindings: canonicalPortBindings(effectivePorts),
			effectivePorts,
			command,
			labels,
			networks,
			networkAttachments,
		};
	});

// -----------------------------------------------------------------------------
// Argv construction
// -----------------------------------------------------------------------------

const normalizeNetworkAttachment = (
	entry: string | NetworkAttachment,
): { readonly name: string; readonly aliases?: ReadonlyArray<string> } =>
	typeof entry === 'string'
		? { name: entry }
		: entry.aliases === undefined || entry.aliases.length === 0
			? { name: entry.name }
			: { name: entry.name, aliases: entry.aliases };

const createArgv = (
	spec: EnsureContainerSpec,
	cycle: number,
	imageRef: string,
): ReadonlyArray<string> => {
	const configLabels: Readonly<Record<string, string>> | undefined =
		spec.configHash === undefined ? undefined : { [LabelKey.configHash]: spec.configHash };
	const labels = renderContainerLabels(spec.labels, cycle, configLabels);
	// First attach is rendered into `--network` + `--network-alias`;
	// subsequent attaches happen post-start via `network connect` so we
	// can wait for IP readback.
	const firstNetwork =
		spec.networkAttach && spec.networkAttach.length > 0
			? normalizeNetworkAttachment(spec.networkAttach[0]!)
			: undefined;
	return renderCreateArgs({
		name: spec.name,
		image: imageRef,
		labels,
		env: spec.env,
		ports: spec.ports,
		mounts: spec.mounts,
		network: firstNetwork,
		addHosts: spec.extraHosts,
		entrypoint: spec.entrypoint,
		command: spec.command,
	});
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
		// best-effort; a non-"no such container" failure does not fail the
		// rm step (the next create will collision-recover).
		yield* dockerRunOk('rm', ['-f', name]).pipe(Effect.mapError(wrapGeneric('docker.rm')));
	});

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

const failUnknownCollisionLifecycle = (
	name: string,
	stage: 'before-start' | 'after-start',
): Effect.Effect<never, DockerRuntimeError> =>
	Effect.fail(
		new ContainerNameCollisionUnrecoverable({
			name,
			detail: `name collision recovery refused unknown lifecycle state ${stage}`,
		}),
	);

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
	});

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
		if (beforeStart.lifecycle.kind === 'unknown') {
			return yield* failUnknownCollisionLifecycle(name, 'before-start');
		}
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
			if (facts.lifecycle.kind === 'unknown') {
				return yield* failUnknownCollisionLifecycle(name, 'after-start');
			}
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

/** `docker run` create with a single `imageRef`. The typed
 *  `ImageNotFound` (from `wrapCreateError`) is propagated as-is so the
 *  caller can decide whether a digest fallback is available. */
const createWithImageRef = (
	spec: EnsureContainerSpec,
	cycle: number,
	imageRef: string,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const args = createArgv(spec, cycle, imageRef);
		const created = yield* dockerRun('run', args).pipe(Effect.mapError(wrapCreateError(spec.name)));
		return created.stdout.trim();
	});

const freshCreate = (
	spec: EnsureContainerSpec,
	cycle: number,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		// Tag-first: `docker run` resolves a human tag when present, else
		// the content-addressed digest. `digest` is always present on an
		// `ImageRef`; `tag` is optional.
		const taggedRef = spec.image.tag ?? spec.image.digest;
		const digestRef = spec.image.digest;
		return yield* createWithImageRef(spec, cycle, taggedRef).pipe(
			// Image-not-found on create means `docker run` tried an implicit
			// registry pull because the local-only ref wasn't present (an
			// interrupted restore left the target un-promoted, or a built
			// image was GC'd). A dangling restored image still resolves by
			// DIGEST unless pruned, so retry with the digest when it differs
			// from the tag we just tried. If that also misses (or there is no
			// distinct digest to try), surface a clear, actionable error.
			Effect.catchTag('ImageNotFound', (notFound) => {
				if (digestRef === taggedRef) {
					return Effect.fail(missingImageError(spec, taggedRef));
				}
				return createWithImageRef(spec, cycle, digestRef).pipe(
					Effect.catchTag('ImageNotFound', () =>
						Effect.fail(missingImageError(spec, taggedRef, digestRef, notFound)),
					),
				);
			}),
		);
	});

/** Clear, actionable failure when neither the tagged nor digest ref
 *  could be created because the image is absent locally. Names the
 *  missing image and points at restore so an operator knows the fix is
 *  re-running restore (which re-promotes / re-loads the image) rather
 *  than a generic create failure. */
const missingImageError = (
	spec: EnsureContainerSpec,
	taggedRef: string,
	digestRef?: string,
	cause?: ImageNotFound,
): ContainerCreateFailed => {
	const tried =
		digestRef !== undefined && digestRef !== taggedRef
			? `tag '${taggedRef}' and digest '${digestRef}'`
			: `image '${taggedRef}'`;
	const causeDetail = cause === undefined ? '' : ` (${cause.detail})`;
	return new ContainerCreateFailed({
		name: spec.name,
		stderr:
			`required image is not present locally — tried ${tried}${causeDetail}. ` +
			'Re-run restore to re-promote / re-load the target image before booting.',
		exitCode: undefined,
	});
};

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
		const created = yield* createWithCollisionRecovery(spec, deps);
		yield* recordRuntimeInvalidation({
			kind: 'container-created',
			name: spec.name,
			cause: 'resume-recreate',
		});
		return created;
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
		if (facts === null || facts.id !== id || facts.lifecycle.kind !== 'running') return id;
		yield* assertOwnedFacts(spec.name, facts, spec.labels);
		if (effectivePortsCompatible(facts, spec)) return id;
		const repairedId = yield* recreateAfterResumeFailure(id, spec, deps);
		const repairedFacts = yield* inspectContainer(spec.name);
		if (
			repairedFacts !== null &&
			repairedFacts.id === repairedId &&
			repairedFacts.lifecycle.kind === 'running' &&
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
			Effect.tapCause((cause) =>
				Effect.logDebug('docker stop failed; container may already be gone', { name, cause }),
			),
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
		// deferred. Interrupt-cleanup mirrors the lease-broker pattern
		// (`substrate/runtime/lease-broker/service.ts:194-216`):
		//   1. If we're still queued → drop our deferred so a future
		//      release doesn't transfer ownership to a dead waiter.
		//   2. If we are NO LONGER queued → a `releasePerNameLock`
		//      already popped us as head (the ONLY way a queued waiter
		//      leaves the queue) and transferred ownership to us, so we
		//      release on our behalf to hand off to the next waiter.
		//
		// We discriminate on queue membership ALONE, not on
		// `Deferred.isDoneUnsafe(waiter)`: release pops the head (step 1
		// of releasePerNameLock's two-step transfer) and only THEN signals
		// the deferred (step 2). Between those steps the popped waiter is
		// already absent from the queue but its deferred is still pending;
		// keying on the signal would (incorrectly) classify us as "still
		// queued" and skip the release, orphaning the slot permanently.
		// A waiter that reached this await is only ever removed by a
		// release popping it, so "not queued ⇒ promoted" is exact —
		// matching the lease-broker, which keys off its explicit `holder`
		// field set atomically with the pop rather than the signal.
		yield* Deferred.await(waiter).pipe(
			Effect.onInterrupt(() =>
				Effect.gen(function* () {
					const promotedButInterrupted = yield* Ref.modify(lock, (m) => {
						const queue = m.get(name);
						if (queue === undefined) {
							// Entry gone entirely → a release fully drained
							// the slot (empty-queue delete) after popping us.
							// We held it; nothing to hand off.
							return [false, m] as const;
						}
						const filtered = queue.filter((d) => d !== waiter);
						if (filtered.length !== queue.length) {
							// Still queued → drop ourselves; the holder
							// will release normally and skip us.
							const next = new Map(m);
							next.set(name, filtered);
							return [false, next as PerNameLockState] as const;
						}
						// Not queued, entry still present. A release already
						// popped us as head and transferred ownership; the
						// rest of the queue is waiting on us. Release on our
						// behalf so the next waiter proceeds.
						return [true, m] as const;
					});
					if (promotedButInterrupted) {
						yield* releasePerNameLock(lock, name);
					}
				}).pipe(Effect.uninterruptible),
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

/** Run `body` while holding the per-name lock for `name`. Wraps the
 *  `acquireUseRelease(acquire, use, release)` triple so every caller
 *  cannot accidentally forget the release on interrupt. The body is
 *  responsible for running uninterruptibly over the inspect→action
 *  window AND arming any stop-on-scope-close finalizer before this
 *  helper releases the lock. */
export const withSerializedContainerOp = <A, E, R>(
	name: string,
	lock: Ref.Ref<PerNameLockState>,
	body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		acquirePerNameLock(lock, name),
		() => body,
		() => releasePerNameLock(lock, name),
	);

/** Idempotent ensure: apply the state machine, register a scope
 *  finalizer that stops the container.
 *
 *  Returns the running container handle (id + name + status + ips). */
export const ensureContainer = (
	spec: EnsureContainerSpec,
	deps: EnsureContainerDeps,
): Effect.Effect<ContainerHandle, DockerRuntimeError, DockerHost | DockerSpawner | Scope.Scope> =>
	Effect.gen(function* () {
		// Per-name lock holds the inspect → applyAction → finalizer-registration
		// window. The lock CANNOT be released before the stop-on-scope-close
		// finalizer is armed: an interrupt in that gap would strand a running
		// container with no scope-bound cleanup until label-driven sweep ran
		// later (per-scope contract: one `Effect.scoped` ⇒ one container
		// managed).
		//
		// The uninterruptible window is NARROWED to the orphan-safety
		// prefix: inspect → applyAction → ensureEffectivePublishedPorts →
		// `registerStopFinalizer`. That prefix MUST be uninterruptible so an
		// interrupt cannot land between "container started" and "finalizer
		// armed" (which would strand a running container with no scope-bound
		// cleanup). Once the stop-on-scope-close finalizer is armed, the
		// remaining work (assertOwned → secondary network attach → IP
		// readback → refresh inspect) runs INTERRUPTIBLY via `restore(...)`:
		// an interrupt there simply triggers the armed finalizer (stop),
		// which is the desired cleanup — so keeping that ~8s tail
		// uninterruptible would only defer Ctrl-C/shutdown for a bounded
		// window with no orphan-safety benefit. The finalizer itself is
		// uninterruptible (Architecture §13).
		const desiredImageRef = spec.image.tag ?? spec.image.digest;
		const registerStopFinalizer = (
			id: string,
		): Effect.Effect<void, never, Scope.Scope | DockerHost | DockerSpawner> =>
			Effect.addFinalizer(() =>
				Effect.gen(function* () {
					// Restore may deliberately remove a claimed container and
					// a later acquire may reuse the name before this scope
					// closes; the old finalizer must not stop that newer
					// container — hence the id check.
					const current = yield* inspectContainer(spec.name).pipe(
						Effect.tapCause((cause) =>
							Effect.logDebug('container inspect during scope-close failed', {
								name: spec.name,
								cause,
							}),
						),
						Effect.catch(() => Effect.succeed(null)),
					);
					if (current?.id === id) {
						yield* stopWithGrace(spec.name, spec.stopGraceSeconds ?? 10, spec.stopSignal);
					}
				}).pipe(Effect.uninterruptible),
			);
		const { id, ips, ports } = yield* withSerializedContainerOp(
			spec.name,
			deps.perNameLock,
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					// --- Orphan-safety prefix (uninterruptible) ---
					// inspect → applyAction → publish-ports → finalizer-arm
					// must run atomically: a stranded running container with
					// no scope-bound cleanup is the failure this guards.
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
						spec.configHash,
						spec.image.digest,
						spec.networkAttach,
					);
					const initialId = yield* applyAction(action, spec, deps);
					const id = yield* ensureEffectivePublishedPorts(initialId, spec, deps);

					// Arm the stop-on-scope-close finalizer BEFORE we
					// release the per-name lock. If anything below this point
					// fails OR is interrupted (assert, network attach) the
					// container will still be stopped at scope close.
					yield* registerStopFinalizer(id);

					// --- Interruptible tail (restore) ---
					// The finalizer is now armed, so an interrupt here is
					// safe: it triggers the scope finalizer (stop). Running
					// this ~8s tail interruptibly keeps Ctrl-C/shutdown
					// responsive during bring-up.
					const tail = yield* restore(
						Effect.gen(function* () {
							yield* assertContainerHandleOwned({
								id,
								name: spec.name,
								labels: spec.labels,
								imageName: spec.image.tag ?? spec.image.digest,
								status: 'running',
								ips: [],
							});

							// Architecture §5 — secondary network attaches (any
							// beyond the first, which is wired in via `--network`
							// on create) must wait for IP allocation before we
							// declare ready.
							const secondaries = (spec.networkAttach ?? [])
								.slice(1)
								.map(normalizeNetworkAttachment);
							for (const net of secondaries) {
								yield* connect(spec.name, net.name, net.aliases);
								yield* waitForIp(spec.name, net.name);
							}

							const ips = yield* readIps(spec.name);
							const refreshedFacts = yield* inspectContainer(spec.name);
							const ports = refreshedFacts?.effectivePorts ?? refreshedFacts?.ports ?? spec.ports;

							return { ips, ports };
						}),
					);

					return { id, ips: tail.ips, ports: tail.ports };
				}),
			),
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
	});

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
				const created = yield* createWithCollisionRecovery(spec, deps);
				yield* recordRuntimeInvalidation({
					kind: 'container-created',
					name: spec.name,
					cause: 'recreate',
				});
				return created;
			}
			case 'fresh': {
				return yield* createWithCollisionRecovery(spec, deps);
			}
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
	});

export const unpause = (
	name: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		yield* dockerRun('unpause', [name]).pipe(Effect.mapError(wrapGeneric('docker.unpause')));
	});

/** Reserved `devstack.role` value stamped on every committed snapshot
 *  byproduct image. Plugin BUILD images carry the source plugin's real
 *  role (`db`, `validator`, …) or no role at all; committed snapshot
 *  images carry THIS sentinel instead. Snapshot prune scopes its image
 *  sweep to `{app, stack, role: SNAPSHOT_IMAGE_ROLE}` so it reaps the
 *  byproducts WITHOUT ever matching the live stack's build images.
 *
 *  This is a label-value protocol token shared with the snapshot prune
 *  orchestrator (`orchestrators/snapshot/prune.ts`), which imports it. */
export const SNAPSHOT_IMAGE_ROLE = 'snapshot-image';

/** Render `{managed, app, stack, role}` ownership labels into
 *  `docker commit --change 'LABEL …'` argv. `docker commit` has no
 *  `--label` flag, so labels must ride in as `--change` Dockerfile
 *  instructions. Values are quoted so an app/stack carrying whitespace
 *  cannot split the instruction. */
const snapshotImageChangeArgs = (
	app: string | undefined,
	stack: string | undefined,
): ReadonlyArray<string> => {
	const labels: Array<[string, string]> = [[LabelKey.managed, 'true']];
	if (app !== undefined) labels.push([LabelKey.app, app]);
	if (stack !== undefined) labels.push([LabelKey.stack, stack]);
	labels.push([LabelKey.role, SNAPSHOT_IMAGE_ROLE]);
	return labels.flatMap(([key, value]) => ['--change', `LABEL "${key}"="${value}"`]);
};

/** `docker commit <name> <tag>` — writable layer → image. Used by
 *  snapshot capture.
 *
 *  The committed image is stamped with `{managed:'true', app, stack,
 *  role:SNAPSHOT_IMAGE_ROLE}` ownership labels so label-driven snapshot
 *  prune can reap leaked byproducts (a hard-killed capture that never
 *  reached its `removeImage` cleanup) while leaving the stack's build
 *  images untouched. A bare `docker commit` produces an UNlabelled image
 *  that no label-driven sweep can find — hence the explicit stamp.
 *
 *  `app`/`stack` are recovered from the source container's own ownership
 *  labels (`docker commit` does NOT copy container labels onto the image).
 *  Capture only commits containers it owns, so those labels are present;
 *  if the inspect misses they are simply omitted and prune's app/stack-
 *  scoped filter will not match — a degenerate case capture cannot reach. */
export const commit = (
	name: string,
	tag: string,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		// Recover the source container's app/stack so the committed image
		// inherits the SAME ownership scope. Best-effort: a failed inspect
		// must not abort the commit (the image is the product; labels are
		// metadata), so degrade to the role-only stamp.
		const facts = yield* inspectContainer(name).pipe(Effect.catch(() => Effect.succeed(null)));
		const sourceLabels = facts?.labels ?? {};
		const changeArgs = snapshotImageChangeArgs(
			sourceLabels[LabelKey.app],
			sourceLabels[LabelKey.stack],
		);
		const res = yield* dockerRun('commit', [...changeArgs, name, tag]).pipe(
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
	});
