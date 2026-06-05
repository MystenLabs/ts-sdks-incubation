// Docker runtime — typed error envelopes.
//
// The public surface speaks in typed errors (`ImageNotFound`,
// `BuildFailed`, …); raw `CaptureError`s from the subprocess seam
// are translated by `wrap.ts` into these envelopes.
//
// Every error is `Data.TaggedError` so callers can `Effect.catchTag`
// the precise failure mode.

import { Data } from 'effect';

import type { ContainerRuntimeError } from '../../contracts/container-runtime.ts';

/** Daemon connection failure. The CLI returned the "Cannot connect to
 *  the Docker daemon" pattern, or the binary is missing. */
export class DaemonUnreachable extends Data.TaggedError('DaemonUnreachable')<{
	readonly op: string;
	readonly detail: string;
	readonly cause?: unknown;
}> {}

/** Image pull / inspect could not locate the requested image. */
export class ImageNotFound extends Data.TaggedError('ImageNotFound')<{
	readonly ref: string;
	readonly detail: string;
}> {}

/** `docker pull` non-zero exit (network / auth / unknown ref). */
export class ImagePullFailed extends Data.TaggedError('ImagePullFailed')<{
	readonly ref: string;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> {}

/** `docker build` non-zero exit. `parsedStep` is best-effort —
 *  populated by `wrap.ts` when the build log surfaces a clear failing
 *  step line. */
export class BuildFailed extends Data.TaggedError('BuildFailed')<{
	readonly contextPath: string;
	readonly dockerfile: string | undefined;
	readonly stderr: string;
	readonly parsedStep?: string;
	readonly exitCode: number | undefined;
}> {}

/** `docker create` / `docker run -d` rejected; not a name collision. */
export class ContainerCreateFailed extends Data.TaggedError('ContainerCreateFailed')<{
	readonly name: string;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> {}

/** `docker run -d -p ...` lost the probe-to-publish race. */
export class ContainerPortPublishConflict extends Data.TaggedError('ContainerPortPublishConflict')<{
	readonly name: string;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> {}

/** Name-collision recovery exhausted: peer beat us and the
 *  start-and-adopt fallback ALSO failed. Architecture forbids the
 *  infinite-loop retry; one shot at adopt then surface this. */
export class ContainerNameCollisionUnrecoverable extends Data.TaggedError(
	'ContainerNameCollisionUnrecoverable',
)<{
	readonly name: string;
	readonly detail: string;
}> {}

/** `docker rm -f` failed while deliberately replacing a managed
 *  container set. Unlike orphan sweep, restore cannot silently leave
 *  the old writable layer in place. */
export class ContainerRemoveFailed extends Data.TaggedError('ContainerRemoveFailed')<{
	readonly name: string;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> {}

export type DockerResourceKind = 'container' | 'network' | 'volume';

/** Docker inspect failed for a reason other than "not found". */
export class DockerInspectFailed extends Data.TaggedError('DockerInspectFailed')<{
	readonly resource: DockerResourceKind;
	readonly name: string;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> {}

/** Docker inspect returned malformed JSON or a shape outside the
 *  runtime's expected schema. */
export class DockerInspectDecodeFailed extends Data.TaggedError('DockerInspectDecodeFailed')<{
	readonly resource: DockerResourceKind;
	readonly name: string;
	readonly detail: string;
	readonly cause?: unknown;
}> {}

/** A same-name Docker resource exists but is not owned by the expected
 *  devstack label tuple, so mutating it would cross stack/plugin
 *  boundaries. */
export class ForeignDockerResource extends Data.TaggedError('ForeignDockerResource')<{
	readonly resource: DockerResourceKind;
	readonly name: string;
	readonly expected: Readonly<Record<string, string>>;
	readonly actual: Readonly<Record<string, string>>;
	readonly detail: string;
}> {}

/** `docker network connect` / `network create` failure that isn't the
 *  idempotent "already exists in network" case. */
export class NetworkOperationFailed extends Data.TaggedError('NetworkOperationFailed')<{
	readonly op: 'create' | 'connect' | 'disconnect' | 'inspect' | 'remove';
	readonly network: string;
	readonly stderr: string;
}> {}

/** `docker network create` exhausted Docker's default bridge IPAM
 *  pools. This is not a daemon reachability failure; stale long-lived
 *  networks or missing explicit subnet/gateway policy are the usual
 *  causes. */
export class NetworkAddressPoolExhausted extends Data.TaggedError('NetworkAddressPoolExhausted')<{
	readonly network: string;
	readonly stderr: string;
	readonly hint: string;
}> {}

/** Container's IP on a secondary network was not allocated within the
 *  bounded poll budget. Architecture § Async network-connect. */
export class NetworkIpReadbackTimeout extends Data.TaggedError('NetworkIpReadbackTimeout')<{
	readonly container: string;
	readonly network: string;
	readonly waitedMillis: number;
}> {}

/** Volume create / inspect failed. */
export class VolumeOperationFailed extends Data.TaggedError('VolumeOperationFailed')<{
	readonly op: 'create' | 'inspect' | 'remove';
	readonly volume: string;
	readonly stderr: string;
}> {}

/** Recreate was refused — the caller's `RecreatePolicy` was `never`
 *  but the lifecycle state machine concluded recreate was required
 *  (image/config mismatch, unclean exit, unknown state). Caller must explicitly opt
 *  in to a recreate to proceed (architecture G1 — Move-build-
 *  container's no-auto-recreate case). */
export class RecreateRefused extends Data.TaggedError('RecreateRefused')<{
	readonly name: string;
	readonly reason:
		| 'image-mismatch'
		| 'config-mismatch'
		| 'unclean-shutdown'
		| 'resume-failed'
		| 'unknown-state';
}> {}

/** Generic exec / one-shot failure when the caller asked us to
 *  promote a non-zero exit. */
export class ExecFailed extends Data.TaggedError('ExecFailed')<{
	readonly name: string;
	readonly argv: ReadonlyArray<string>;
	readonly exitCode: number;
	readonly stderr: string;
}> {}

/** `docker save` failed — daemon error, missing image, or pipe failure
 *  draining stdout. */
export class ImageSaveFailed extends Data.TaggedError('ImageSaveFailed')<{
	readonly ref: string;
	readonly detail: string;
	readonly cause?: unknown;
}> {}

/** `docker load` failed — corrupt tar, daemon error, or no `Loaded
 *  image:` line parsed from stdout. */
export class ImageLoadFailed extends Data.TaggedError('ImageLoadFailed')<{
	readonly detail: string;
	readonly stderr?: string;
	readonly cause?: unknown;
}> {}

/** `docker tag` failed — source image missing or invalid tag string. */
export class ImageTagFailed extends Data.TaggedError('ImageTagFailed')<{
	readonly src: string;
	readonly dst: string;
	readonly stderr: string;
}> {}

/** `docker image rm` failed while removing managed snapshot/build
 *  byproducts. */
export class ImageRemoveFailed extends Data.TaggedError('ImageRemoveFailed')<{
	readonly ref: string;
	readonly stderr: string;
	readonly exitCode: number | undefined;
}> {}

/** Union of every docker-runtime typed error. */
export type DockerRuntimeError =
	| DaemonUnreachable
	| ImageNotFound
	| ImagePullFailed
	| BuildFailed
	| ContainerCreateFailed
	| ContainerPortPublishConflict
	| ContainerNameCollisionUnrecoverable
	| ContainerRemoveFailed
	| DockerInspectFailed
	| DockerInspectDecodeFailed
	| ForeignDockerResource
	| NetworkOperationFailed
	| NetworkAddressPoolExhausted
	| NetworkIpReadbackTimeout
	| VolumeOperationFailed
	| RecreateRefused
	| ExecFailed
	| ImageSaveFailed
	| ImageLoadFailed
	| ImageTagFailed
	| ImageRemoveFailed;

/** Project a typed `DockerRuntimeError` into the contract-shaped
 *  `ContainerRuntimeError`. The contract is intentionally narrow
 *  (`reason` is a closed enum); plugins that want the precise tag
 *  can `Effect.catchTag` against the typed errors BEFORE the contract
 *  projection runs. */
export const toContractError = (err: DockerRuntimeError): ContainerRuntimeError => {
	switch (err._tag) {
		case 'DaemonUnreachable':
			return { _tag: 'ContainerRuntimeError', reason: 'daemon-unreachable', detail: err.detail };
		case 'ImageNotFound':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-build-failed',
				detail: `${err.ref}: ${err.detail}`,
			};
		case 'ImagePullFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-build-failed',
				detail: `pull ${err.ref} failed: ${err.stderr}`,
			};
		case 'BuildFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-build-failed',
				detail: err.parsedStep ?? err.stderr,
			};
		case 'ContainerCreateFailed':
		case 'ContainerNameCollisionUnrecoverable':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'name-collision',
				detail: 'detail' in err ? err.detail : err.stderr,
			};
		case 'ContainerPortPublishConflict':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'publish-port-conflict',
				detail: `${err.name}: ${err.stderr}`,
			};
		case 'ContainerRemoveFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'container-replace-failed',
				detail: `${err.name}: ${err.stderr}`,
			};
		case 'DockerInspectFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'docker-inspect-failed',
				detail: `${err.resource} ${err.name}: ${err.stderr}`,
			};
		case 'DockerInspectDecodeFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'docker-inspect-failed',
				detail: `${err.resource} ${err.name}: ${err.detail}`,
			};
		case 'ForeignDockerResource':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'foreign-resource',
				detail: `${err.resource} ${err.name}: ${err.detail}`,
			};
		case 'NetworkOperationFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'daemon-unreachable',
				detail: `network ${err.op} ${err.network}: ${err.stderr}`,
			};
		case 'NetworkAddressPoolExhausted':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'network-address-pool-exhausted',
				detail: `network create ${err.network}: ${err.hint} stderr=${err.stderr}`,
			};
		case 'NetworkIpReadbackTimeout':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'ip-readback-timeout',
				detail: `${err.container} on ${err.network} after ${err.waitedMillis}ms`,
			};
		case 'VolumeOperationFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'daemon-unreachable',
				detail: `volume ${err.op} ${err.volume}: ${err.stderr}`,
			};
		case 'RecreateRefused':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'recreate-refused',
				detail: `${err.name}: ${err.reason}`,
			};
		case 'ExecFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'ready-probe-failed',
				detail: `exec ${err.name} exit ${err.exitCode}: ${err.stderr}`,
			};
		case 'ImageSaveFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-save-failed',
				detail: `${err.ref}: ${err.detail}`,
			};
		case 'ImageLoadFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-load-failed',
				detail: err.stderr !== undefined ? `${err.detail}: ${err.stderr}` : err.detail,
			};
		case 'ImageTagFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-tag-failed',
				detail: `${err.src} → ${err.dst}: ${err.stderr}`,
			};
		case 'ImageRemoveFailed':
			return {
				_tag: 'ContainerRuntimeError',
				reason: 'image-remove-failed',
				detail: `${err.ref}: ${err.stderr}`,
			};
	}
};
