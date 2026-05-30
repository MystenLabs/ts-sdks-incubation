// Subprocess-capture → typed docker-error translation.
//
// Architecture inverts the legacy "stderr-pattern wording" coupling:
// instead of every plugin staring at stderr substrings, we classify
// in ONE place and surface typed errors. Plugins consume typed errors
// (`ImageNotFound`, `BuildFailed`, …) and never see raw stderr text
// outside the error envelope's `detail` field.
//
// Stderr classifiers are kept here, not scattered. New runtime
// backends (podman / finch) ship their own dialect of the classifier
// set; the typed-error surface is the same.

import type {
	CaptureError,
	CaptureResult,
} from '../../substrate/runtime/observability/subprocess-capture.ts';
import {
	BuildFailed,
	ContainerCreateFailed,
	ContainerNameCollisionUnrecoverable,
	ContainerPortPublishConflict,
	DaemonUnreachable,
	type DockerRuntimeError,
	ImageNotFound,
	ImagePullFailed,
	NetworkAddressPoolExhausted,
	NetworkOperationFailed,
	VolumeOperationFailed,
} from './errors.ts';

// -----------------------------------------------------------------------------
// Classifiers
// -----------------------------------------------------------------------------

/** Daemon unreachable — the connection itself failed. Highest-priority
 *  classifier; if this is true, no further classification is meaningful. */
export const isDaemonUnreachableStderr = (stderr: string): boolean =>
	/Cannot connect to the Docker daemon/i.test(stderr) ||
	/Is the docker daemon running\?/i.test(stderr) ||
	/ENOENT.*docker/i.test(stderr);

/** Name collision — `docker create` / `run -d` returns exit 125 with
 *  "name is already in use" wording. Architecture §1 — name-atomic create. */
export const isNameCollisionStderr = (stderr: string): boolean =>
	/is already in use by container/i.test(stderr) || /Conflict.*The container name/i.test(stderr);

/** Port conflict — used by container resume-fallback path. */
export const isPortConflictStderr = (stderr: string): boolean =>
	/port is already allocated/i.test(stderr) || /bind.*address already in use/i.test(stderr);

/** "No such container" — TOCTOU recovery signal. */
export const isNoSuchContainerStderr = (stderr: string): boolean =>
	/No such container/i.test(stderr) ||
	/Error response from daemon: No such container/i.test(stderr) ||
	/no such object/i.test(stderr);

/** Network attach idempotency — "already exists in network" is success. */
export const isAlreadyInNetworkStderr = (stderr: string): boolean =>
	/already exists in network/i.test(stderr) || /endpoint with name .* already exists/i.test(stderr);

/** Network-create collision — `docker network create` is NOT name-atomic
 *  and there is no per-name lock for networks, so two processes booting
 *  against the shared `devstack` bridge can both pass the inspect-miss and
 *  both run `create`; the loser sees this stderr. Matches the daemon's
 *  canonical wording `network with name <name> already exists` plus the
 *  `Conflict` (409) envelope libnetwork returns for the same condition.
 *  Distinct from `isAlreadyInNetworkStderr` (the connect-side
 *  endpoint-already-attached case) — this is the network object itself
 *  already existing, the signal for `ensureNetwork`'s adopt-on-collision
 *  re-inspect. */
export const isNetworkAlreadyExistsStderr = (stderr: string): boolean =>
	/network with name \S+ already exists/i.test(stderr) ||
	/Conflict.*network/i.test(stderr) ||
	/network \S+ already exists/i.test(stderr);

/** Docker bridge IPAM exhaustion. This is a stale-network / missing
 *  explicit-subnet policy failure, not a daemon reachability failure. */
export const isNetworkAddressPoolExhaustedStderr = (stderr: string): boolean =>
	/all predefined address pools have been fully subnetted/i.test(stderr);

/** Image not found — pull or inspect against an unknown ref. */
export const isImageNotFoundStderr = (stderr: string): boolean =>
	/pull access denied/i.test(stderr) ||
	/manifest .* not found/i.test(stderr) ||
	/repository .* not found/i.test(stderr) ||
	/No such image/i.test(stderr);

/** Image missing — classifier for `docker image rm` / `docker tag`
 *  flows. Matches the daemon's canonical wording only — a bare
 *  `/not found/` alternation would misclassify permission-denied and
 *  registry-auth errors (e.g. `pull access denied … repository does
 *  not exist`) as "missing" and let sweep silently skip them. Distinct
 *  from `isImageNotFoundStderr` (pull-flow-specific) — this one is the
 *  union used by idempotent remove/tag paths. */
export const isMissingImageStderr = (stderr: string): boolean =>
	/no such image|reference does not exist/i.test(stderr);

/** Network missing — idempotent classifier for `docker network rm` /
 *  `docker network inspect`. Matches the daemon's canonical wordings:
 *  `No such network: <name>` and `network <name> not found`. A bare
 *  `/not found/` alternation would misclassify auth / permission errors
 *  on shared docker hosts. */
export const isMissingNetworkStderr = (stderr: string): boolean =>
	/no such network|network \S+ not found/i.test(stderr);

/** Network in-use — `docker network rm` failed because endpoints are
 *  still attached. Inverse predicate of `isMissingNetworkStderr`; lives
 *  next to its siblings so the two evolve together. */
export const isNetworkInUseStderr = (stderr: string): boolean =>
	/active endpoints|has active endpoint|network .* is in use/i.test(stderr);

// -----------------------------------------------------------------------------
// Wrappers — translate CaptureError → typed DockerRuntimeError
// -----------------------------------------------------------------------------

/** Daemon-unreachable check is the universal short-circuit. Every
 *  wrapper runs this first. */
const checkDaemon = (err: CaptureError): DaemonUnreachable | null => {
	if (isDaemonUnreachableStderr(err.stderr)) {
		return new DaemonUnreachable({
			op: err.op,
			detail: 'docker daemon unreachable',
			cause: err.cause,
		});
	}
	if (err.cause !== undefined && err.exitCode === undefined) {
		return new DaemonUnreachable({
			op: err.op,
			detail: 'docker CLI spawn failed (binary missing or fork failure)',
			cause: err.cause,
		});
	}
	return null;
};

export const wrapPullError =
	(ref: string) =>
	(err: CaptureError): DockerRuntimeError => {
		const d = checkDaemon(err);
		if (d) return d;
		if (isImageNotFoundStderr(err.stderr)) {
			return new ImageNotFound({ ref, detail: 'pull target not found' });
		}
		return new ImagePullFailed({ ref, stderr: err.stderr, exitCode: err.exitCode });
	};

export const wrapBuildError =
	(contextPath: string, dockerfile: string | undefined) =>
	(err: CaptureError): DockerRuntimeError => {
		const d = checkDaemon(err);
		if (d) return d;
		// STUB: best-effort parse of `Step <n>/<m> : <line>` from a
		// buildkit / classic builder log. The architecture allows this
		// to be empty — the raw stderr is still surfaced in `detail`.
		// Follow-up: extract from buildkit's `#<n> ERROR: …` envelope.
		const parsedStep = parseFailingBuildStep(err.stdout, err.stderr);
		return new BuildFailed({
			contextPath,
			dockerfile,
			stderr: err.stderr,
			parsedStep,
			exitCode: err.exitCode,
		});
	};

export const wrapCreateError =
	(name: string) =>
	(err: CaptureError): DockerRuntimeError => {
		const d = checkDaemon(err);
		if (d) return d;
		if (isNameCollisionStderr(err.stderr)) {
			// Architecture §1: surface the collision typed so the
			// state machine can decide adopt vs typed-failure. The
			// `Unrecoverable` variant fires only AFTER the start-and-
			// adopt fallback has exhausted; here we signal the collision
			// for the caller to handle.
			return new ContainerNameCollisionUnrecoverable({
				name,
				detail: 'name collision; caller should attempt adopt fallback',
			});
		}
		if (isPortConflictStderr(err.stderr)) {
			return new ContainerPortPublishConflict({
				name,
				stderr: err.stderr,
				exitCode: err.exitCode,
			});
		}
		return new ContainerCreateFailed({ name, stderr: err.stderr, exitCode: err.exitCode });
	};

export const wrapNetworkError =
	(op: 'create' | 'connect' | 'disconnect' | 'inspect' | 'remove', network: string) =>
	(err: CaptureError): DockerRuntimeError => {
		const d = checkDaemon(err);
		if (d) return d;
		if (op === 'create' && isNetworkAddressPoolExhaustedStderr(err.stderr)) {
			return new NetworkAddressPoolExhausted({
				network,
				stderr: err.stderr,
				hint: 'Docker exhausted its predefined bridge address pools. Remove stale devstack networks with wipe/prune (for example `docker network prune`) or request an explicit non-overlapping subnet/gateway.',
			});
		}
		return new NetworkOperationFailed({ op, network, stderr: err.stderr });
	};

export const wrapVolumeError =
	(op: 'create' | 'inspect' | 'remove', volume: string) =>
	(err: CaptureError): DockerRuntimeError => {
		const d = checkDaemon(err);
		if (d) return d;
		return new VolumeOperationFailed({ op, volume, stderr: err.stderr });
	};

/** Generic wrapper for op surfaces (`docker logs`, `docker inspect`,
 *  etc.) where the only distinct failure mode is daemon down. */
export const wrapGeneric =
	(op: string) =>
	(err: CaptureError): DockerRuntimeError =>
		checkDaemon(err) ??
		new DaemonUnreachable({
			op,
			detail: err.stderr || `${op} failed (exit ${err.exitCode ?? '?'})`,
			cause: err.cause,
		});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** STUB: extract a "failing step" line from build output. The
 *  buildkit envelope shape is documented; classic builder shape is
 *  `Step N/M : <directive>`. Returning `undefined` is fine — the raw
 *  stderr is still in the BuildFailed envelope. */
const parseFailingBuildStep = (stdout: string, stderr: string): string | undefined => {
	const combined = `${stderr}\n${stdout}`;
	const classic = combined.match(/Step (\d+)\/(\d+)\s*:\s*([^\n]+)/);
	if (classic) return `Step ${classic[1]}/${classic[2]} ${classic[3]}`;
	const buildkit = combined.match(/#(\d+)\s+ERROR\s*:\s*([^\n]+)/);
	if (buildkit) return `#${buildkit[1]} ${buildkit[2]}`;
	return undefined;
};

/** Inspect a `CaptureResult`'s exit code; if non-zero return null
 *  (caller decides what to do). Used by the lifecycle state machine
 *  to classify stderr patterns WITHOUT promoting non-zero to failure
 *  via `nonZeroIsFailure`. */
export const classifyExit = (
	res: CaptureResult,
): { readonly ok: boolean; readonly exitCode: number; readonly stderr: string } => ({
	ok: res.exitCode === 0,
	exitCode: res.exitCode,
	stderr: res.stderr,
});
