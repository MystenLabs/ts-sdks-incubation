// ContainerRuntime capability contract (architecture §2).
//
// Backend-agnostic container-shaped resource manager. Docker is the
// reference implementation; podman / host-process / sandbox are not
// foreclosed.
//
// Architecture Decision §5: `ensureContainer` accepts a recreate
// policy enum (`'on-failure' | 'never' | 'on-config-change'`). The
// per-name lease broker (one substrate primitive in L0) handles the
// policy uniformly.

import type { Duration, Effect, Scope, Stream } from 'effect';

import type { ContainerLabelTuple } from './snapshotable.ts';

export type RecreatePolicy = 'on-failure' | 'never' | 'on-config-change';

/** Content-addressed image reference. Substrate folds builds into
 *  the cache via this. */
export interface ImageRef {
	readonly digest: string;
	readonly tag?: string;
}

export interface SaveImageOptions {
	readonly removeAfterSave?: boolean;
}

export interface TagImageOptions {
	readonly removeSourceAfterTag?: boolean;
}

export interface ContainerBuildContext {
	readonly contextPath: string;
	readonly dockerfile?: string;
	readonly buildArgs?: Readonly<Record<string, string>>;
}

export interface ContainerPortPublish {
	readonly containerPort: number;
	readonly hostPort: number;
	readonly hostIp?: string;
}

export type PortBindingReconciliation = 'exact' | 'adopt-existing';

export interface EnsureContainerSpec {
	readonly name: string;
	readonly image: ImageRef;
	readonly labels: ContainerLabelTuple;
	readonly recreate: RecreatePolicy;
	readonly env?: Readonly<Record<string, string>>;
	readonly ports?: ReadonlyArray<ContainerPortPublish>;
	/** Grace window, in seconds, used by the scope finalizer before
	 *  Docker escalates container stop to SIGKILL. Stateful containers
	 *  with RocksDB/WAL-backed data should request enough time to flush
	 *  cleanly; the runtime default is 10 seconds. */
	readonly stopGraceSeconds?: number;
	/** How published host ports participate in existing-container
	 *  reconciliation. Default `exact` treats a binding mismatch as
	 *  config drift. `adopt-existing` lets a same-name, image-matching
	 *  container keep its current published ports; callers must read
	 *  the returned `ContainerHandle.ports` before constructing URLs. */
	readonly portBindingReconciliation?: PortBindingReconciliation;
	readonly networkAttach?: ReadonlyArray<string>;
	/** Bind mounts. The build-container path lives here: source dir →
	 *  container path. `readonly: true` flips on the docker mount
	 *  read-only flag. */
	readonly mounts?: ReadonlyArray<{
		readonly source: string;
		readonly target: string;
		readonly readonly?: boolean;
	}>;
	/** Optional `--entrypoint <bin>` override. The Move build container
	 *  uses `sh` so the long-lived sleeper can be `sh -c 'sleep infinity'`. */
	readonly entrypoint?: string;
	/** Optional positional argv appended after the image. Used to set the
	 *  sleeper's `sleep infinity` command without changing the image. */
	readonly command?: ReadonlyArray<string>;
	/** Extra `<host>:<ip>` entries to inject into /etc/hosts via
	 *  `docker run --add-host`. The literal `host-gateway` is supported
	 *  on every modern Docker daemon (DfM/DfW + Docker Engine since
	 *  20.10) and resolves to the container's view of the host
	 *  loopback — necessary for in-container processes to reach
	 *  host-published ports on native Linux where `host.docker.internal`
	 *  isn't auto-installed. Walrus uses this to reach sui's host-bound
	 *  RPC + faucet from inside its own per-stack network. */
	readonly extraHosts?: Readonly<Record<string, string>>;
}

/** Spec for `ContainerRuntime.runOneShot` — a transient
 *  `docker run --rm` container. Path (b) in `runMoveBuild`'s
 *  three-way dispatch. */
export interface OneShotSpec {
	readonly image: ImageRef;
	readonly argv?: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	readonly mounts?: ReadonlyArray<{
		readonly source: string;
		readonly target: string;
		readonly readonly?: boolean;
	}>;
	readonly network?: string;
	readonly entrypoint?: string;
	/** Optional numeric or named user for `docker run --user`.
	 *  Use for one-shots that write into host bind mounts so Linux
	 *  Docker does not leave root-owned files behind. */
	readonly user?: string;
	/** Wall-clock timeout. After this the subprocess is killed; a
	 *  belt-and-suspenders `rm -f` finalizer catches containers that
	 *  outlived the foreground subprocess. */
	readonly timeoutMillis?: number;
	/** Extra `<host>:<ip>` entries injected via `docker run --add-host`.
	 *  See `EnsureContainerSpec.extraHosts`. */
	readonly extraHosts?: Readonly<Record<string, string>>;
}

export interface ContainerHandle {
	readonly id: string;
	readonly name: string;
	/** Exact ownership tuple stamped on the current Docker resource.
	 *  Runtime operations that mutate by stable name use this to
	 *  re-check the live labels before exec/pause/commit/unpause/stop. */
	readonly labels?: ContainerLabelTuple;
	/** Image ref Docker recorded at container creation time. This is
	 *  the same string `ensureContainer` compares against on adoption,
	 *  so snapshot restore must re-tag loaded images to this ref. */
	readonly imageName: string;
	readonly status: 'running' | 'exited' | 'paused' | 'created';
	readonly ips: ReadonlyArray<string>;
	readonly ports?: ReadonlyArray<ContainerPortPublish>;
}

/** Captured stdout/stderr/exit code from a one-shot `exec` invocation
 *  inside a running container. */
export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Optional knobs for `ContainerRuntime.exec`. */
export interface ExecOptions {
	readonly user?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly workdir?: string;
}

/** Spec for the idempotent per-stack network create. */
export interface EnsureNetworkSpec {
	readonly name: string;
	readonly app: string;
	readonly stack: string;
}

/** The substrate-facing runtime adapter. Implementation lives in
 *  `runtime/docker/`. */
export interface ContainerRuntime {
	readonly ensureImage: (
		build: ContainerBuildContext,
		expected?: ImageRef,
	) => Effect.Effect<ImageRef, ContainerRuntimeError>;

	readonly pullImage?: (ref: string) => Effect.Effect<ImageRef, ContainerRuntimeError>;

	/** Idempotently create a docker network. Returns the network's id.
	 *  No-op (returns existing id) if the network already exists.
	 *  Networks outlive container scopes — there is NO finalizer; the
	 *  network is reaped by `wipe` / `prune`, not by the supervisor. */
	readonly ensureNetwork: (spec: EnsureNetworkSpec) => Effect.Effect<string, ContainerRuntimeError>;

	readonly ensureContainer: (
		spec: EnsureContainerSpec,
	) => Effect.Effect<ContainerHandle, ContainerRuntimeError, Scope.Scope>;

	/** Run a one-shot command inside a running container and capture
	 *  its output. The runtime does NOT promote a non-zero exit to
	 *  failure — the caller is the policy holder (the postgres plugin
	 *  treats non-zero from `pg_isready` as "retry", but non-zero from
	 *  `createdb` as a typed plugin error). Only daemon-level failures
	 *  (no such container, daemon unreachable) surface as
	 *  `ContainerRuntimeError`. */
	readonly exec: (
		handle: ContainerHandle,
		argv: ReadonlyArray<string>,
		opts?: ExecOptions,
	) => Effect.Effect<ExecResult, ContainerRuntimeError>;

	/** Run a one-shot `docker run --rm` container and capture stdout +
	 *  stderr + exit code. Used by `runMoveBuild`'s path (b) — fresh
	 *  ephemeral container per build when no long-lived build container
	 *  is available. Belt-and-suspenders `rm -f` finalizer fires on
	 *  scope close to catch containers that survived a foreground kill. */
	readonly runOneShot: (
		spec: OneShotSpec,
	) => Effect.Effect<ExecResult, ContainerRuntimeError, Scope.Scope>;

	readonly inspectByLabels: (
		labels: ContainerLabelTuple,
	) => Effect.Effect<ReadonlyArray<ContainerHandle>, ContainerRuntimeError>;

	readonly followLogs: (handle: ContainerHandle) => Stream.Stream<string, ContainerRuntimeError>;

	/** Commit a container's writable layer to a snapshot image. Running
	 *  containers are paused first; paused, exited, and created
	 *  containers are already quiescent and are committed as-is. */
	readonly pauseAndCommit: (
		handle: ContainerHandle,
	) => Effect.Effect<ImageRef, ContainerRuntimeError>;

	/** Stream an image's bytes as if produced by `docker save <ref>`.
	 *  Used by the snapshot orchestrator to persist committed images to
	 *  tar files; consumers compose with a file-write sink so large
	 *  images don't materialise in memory. */
	readonly saveImage: (
		ref: ImageRef,
		opts?: SaveImageOptions,
	) => Stream.Stream<Uint8Array, ContainerRuntimeError>;

	/** Load an image from a `docker save`-shaped tar stream. Returns
	 *  the resolved `ImageRef` of the freshly-imported image. Symmetric
	 *  with `saveImage`. Upstream stream errors are projected to
	 *  `image-load-failed`. */
	readonly loadImage: (
		tar: Stream.Stream<Uint8Array, unknown>,
	) => Effect.Effect<ImageRef, ContainerRuntimeError>;

	/** Move/copy a tag onto a source image. After this returns,
	 *  `<newTag>` resolves to the same image as `src`. Used by snapshot
	 *  restore to alias a freshly-loaded image back to the originally-
	 *  recorded name. */
	readonly tagImage: (
		src: ImageRef,
		newTag: string,
		opts?: TagImageOptions,
	) => Effect.Effect<void, ContainerRuntimeError>;

	readonly unpause: (handle: ContainerHandle) => Effect.Effect<void, ContainerRuntimeError>;

	readonly stop: (
		handle: ContainerHandle,
		grace: Duration.Duration,
	) => Effect.Effect<void, ContainerRuntimeError>;

	/** Boot-time orphan cleanup. This is container-only and skips names
	 *  still present in the cross-process claim ledger. */
	readonly sweepOrphans: (
		labelMatch: Partial<ContainerLabelTuple>,
	) => Effect.Effect<number, ContainerRuntimeError>;

	/** Force-remove managed containers matching the partial label tuple,
	 *  regardless of claim-ledger entries. Wipe uses this for explicit
	 *  teardown; restore uses it before the next `ensureContainer`
	 *  recreates names from restored image tags. */
	readonly removeManagedContainers: (
		labelMatch: Partial<ContainerLabelTuple>,
	) => Effect.Effect<number, ContainerRuntimeError>;

	/** Remove managed Docker images matching the partial label tuple.
	 *  Implementations must enumerate by ownership labels, never by tag
	 *  prefix alone. */
	readonly removeManagedImages: (
		labelMatch: Partial<ContainerLabelTuple>,
	) => Effect.Effect<number, ContainerRuntimeError>;

	/** Remove managed Docker networks matching the partial label tuple.
	 *  Implementations must enumerate by ownership labels and must not
	 *  remove unlabelled or foreign resources. */
	readonly removeManagedNetworks: (
		labelMatch: Partial<ContainerLabelTuple>,
	) => Effect.Effect<number, ContainerRuntimeError>;

	/** Remove managed Docker volumes matching the partial label tuple.
	 *  Implementations must enumerate by ownership labels and must not
	 *  remove unlabelled or foreign resources. */
	readonly removeManagedVolumes: (
		labelMatch: Partial<ContainerLabelTuple>,
	) => Effect.Effect<number, ContainerRuntimeError>;
}

export interface ContainerRuntimeError {
	readonly _tag: 'ContainerRuntimeError';
	readonly reason:
		| 'daemon-unreachable'
		| 'image-build-failed'
		| 'image-save-failed'
		| 'image-load-failed'
		| 'image-tag-failed'
		| 'docker-inspect-failed'
		| 'foreign-resource'
		| 'container-replace-failed'
		| 'name-collision'
		| 'publish-port-conflict'
		| 'ip-readback-timeout'
		| 'ready-probe-failed'
		| 'recreate-refused'
		| 'image-remove-failed';
	readonly detail: string;
}
