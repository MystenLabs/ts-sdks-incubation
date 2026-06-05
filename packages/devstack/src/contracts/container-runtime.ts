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

export interface TaggedImageRef extends ImageRef {
	readonly tag: string;
}

export interface LoadedImageBundle {
	readonly refs: ReadonlyArray<ImageRef>;
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
	/** Optional context-relative paths that define this image's cache
	 *  identity. Omitted or empty means fingerprint the whole Docker build
	 *  context. Use this when Docker needs a shared parent context only to
	 *  copy a small set of files; unrelated sibling image edits must not
	 *  retag stateful containers. */
	readonly fingerprintPaths?: ReadonlyArray<string>;
	/** Optional Docker build platform, for example `linux/amd64`.
	 *  Omitted means Docker uses the host/default platform. */
	readonly platform?: string;
	readonly buildArgs?: Readonly<Record<string, string>>;
	/** Optional owner identity. When set, the runtime stamps
	 *  `{managed:'true', app, stack, plugin?, role?}` as `--label` flags
	 *  on `docker build`, making the resulting image visible to
	 *  label-driven prune. Without it the image lands unlabelled. */
	readonly owner?: {
		readonly app: string;
		readonly stack: string;
		readonly plugin?: string;
		readonly role?: string;
	};
}

export interface ContainerPortPublish {
	readonly containerPort: number;
	readonly hostPort: number;
	readonly hostIp?: string;
}

export type PortBindingReconciliation = 'exact' | 'adopt-existing';

/** Per-network DNS alias plumbing. `aliases` are passed through to
 *  Docker as `--network-alias` (first attach, baked into
 *  `docker run`) or `--alias` (subsequent attaches via
 *  `docker network connect`). */
export interface NetworkAttachment {
	readonly name: string;
	readonly aliases?: ReadonlyArray<string>;
}

export interface EnsureContainerSpec {
	readonly name: string;
	readonly image: ImageRef;
	readonly labels: ContainerLabelTuple;
	readonly recreate: RecreatePolicy;
	/** Optional caller-owned fingerprint for config that Docker cannot
	 *  infer from image or port bindings (for example files behind a
	 *  bind mount). When set, `on-config-change` recreates an existing
	 *  container whose recorded fingerprint differs. */
	readonly configHash?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly ports?: ReadonlyArray<ContainerPortPublish>;
	/** Grace window, in seconds, used by the scope finalizer before
	 *  Docker escalates container stop to SIGKILL. Stateful containers
	 *  with RocksDB/WAL-backed data should request enough time to flush
	 *  cleanly; the runtime default is 10 seconds. */
	readonly stopGraceSeconds?: number;
	/** Optional signal for the scope finalizer's `docker stop` call.
	 *  Omit to use Docker's image/default stop signal. */
	readonly stopSignal?: string;
	/** How published host ports participate in existing-container
	 *  reconciliation. Default `exact` treats a binding mismatch as
	 *  config drift. `adopt-existing` lets a same-name, image-matching
	 *  container keep its current published ports; callers must read
	 *  the returned `ContainerHandle.ports` before constructing URLs. */
	readonly portBindingReconciliation?: PortBindingReconciliation;
	/** Networks to attach. Each entry is either a bare network name
	 *  (no extra DNS aliases) or `{ name, aliases }` to register
	 *  per-network DNS aliases via `docker run --network-alias` (for the
	 *  first attach) or `docker network connect --alias` (for any
	 *  subsequent attach). Docker registers the container name on every
	 *  attached network unconditionally; aliases here are *additional*
	 *  DNS names siblings can dial under the same network. */
	readonly networkAttach?: ReadonlyArray<string | NetworkAttachment>;
	/** Bind mounts. The build-container path lives here: source dir →
	 *  container path. `readonly: true` flips on the docker mount
	 *  read-only flag. */
	readonly mounts?: ReadonlyArray<{
		readonly source: string;
		readonly target: string;
		readonly readonly?: boolean;
	}>;
	/** Optional `--entrypoint <bin>` override. The Move build container
	 *  uses `sh` so its long-lived sleeper can trap Docker stop signals. */
	readonly entrypoint?: string;
	/** Optional positional argv appended after the image. Used to set the
	 *  sleeper command without changing the image. */
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
	/** The container's last recorded exit code, surfaced from
	 *  `InspectFacts.exitCode` whenever Docker supplied a `State` (so a
	 *  running container or one that exited cleanly reports `0`; only a
	 *  container whose inspect omitted `State` entirely — an indeterminate
	 *  lifecycle — leaves this absent). Lets callers distinguish a clean exit
	 *  from a SIGKILL/OOM `137` — the only code the runtime's `decideRunAction`
	 *  recreates an `on-failure` container on. Sui's indexer-db sidecar keys
	 *  its `configHash` on `present + 137` (a validator crash-recreate ⇒
	 *  re-genesis incoming) so it resets rather than resuming stale rows
	 *  against a brand-new chain. */
	readonly lastExitCode?: number;
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
	/** Optional IPAM subnet (`10.42.7.0/24`) for callers that own
	 *  deterministic in-network addresses and must not consume Docker's
	 *  default bridge address pools. */
	readonly subnet?: string;
	/** Optional gateway inside `subnet` (`10.42.7.1`). */
	readonly gateway?: string;
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
	 *  failure — the caller is the policy holder. Only daemon-level
	 *  failures (no such container, daemon unreachable) surface as
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

	/** Commit a container's writable layer to a snapshot image. Running
	 *  containers are paused first; paused, exited, and created
	 *  containers are already quiescent and are committed as-is. */
	readonly pauseAndCommit: (
		handle: ContainerHandle,
	) => Effect.Effect<TaggedImageRef, ContainerRuntimeError>;

	/** Stream a deduplicated `docker save <ref...>` bundle. Snapshot
	 *  capture uses this for multi-container stacks so shared base layers
	 *  are written once per snapshot instead of once per container. */
	readonly saveImages: (
		refs: ReadonlyArray<ImageRef>,
		opts?: SaveImageOptions,
	) => Stream.Stream<Uint8Array, ContainerRuntimeError>;

	/** Load one `docker save`-shaped tar stream. Returns the refs Docker
	 *  reported loading from that stream so restore can prove expected
	 *  snapshot tags came from the artifact before it retags them. */
	readonly loadImage: (
		tar: Stream.Stream<Uint8Array, unknown>,
	) => Effect.Effect<LoadedImageBundle, ContainerRuntimeError>;

	/** Move/copy a tag onto a source image. After this returns,
	 *  `<newTag>` resolves to the same image as `src`. Used by snapshot
	 *  restore to alias a freshly-loaded image back to the originally-
	 *  recorded name. */
	readonly tagImage: (
		src: ImageRef,
		newTag: string,
		opts?: TagImageOptions,
	) => Effect.Effect<void, ContainerRuntimeError>;

	/** Remove one image ref/tag. Snapshot capture uses this only for
	 *  committed temp tags when capture fails before `saveImages` takes
	 *  ownership of cleanup via `removeAfterSave`. Missing refs are
	 *  treated as already-cleaned. */
	readonly removeImage: (ref: ImageRef) => Effect.Effect<void, ContainerRuntimeError>;

	/** Resolve a ref (tag or digest) to the image id/digest it currently
	 *  points at, or `null` when the ref does not exist on-host. Snapshot
	 *  capture-resume uses this to identify the layer a name resolved to
	 *  BEFORE a retag (the soon-to-be-superseded layer) and the layer it
	 *  resolves to AFTER (the freshly-committed one), so the orphaned
	 *  previous layer can be GC'd without touching the live tag. */
	readonly inspectImageDigest: (ref: string) => Effect.Effect<string | null, ContainerRuntimeError>;

	readonly stop: (
		handle: ContainerHandle,
		grace: Duration.Duration,
	) => Effect.Effect<void, ContainerRuntimeError>;

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
		| 'network-address-pool-exhausted'
		| 'ip-readback-timeout'
		| 'ready-probe-failed'
		| 'recreate-refused'
		| 'image-remove-failed';
	readonly detail: string;
}
