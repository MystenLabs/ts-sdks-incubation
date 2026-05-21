// Docker network lifecycle.
//
// Architecture § Docker backend § Networking:
//   - ONE shared `devstack` network per host (cross-stack). Other
//     per-stack secondary networks are allowed by callers, but the
//     default surface assumes the shared bridge.
//   - `network connect` is idempotent — "already exists in network"
//     stderr is success (see `wrap.ts` classifier).
//   - `network connect` settle is ASYNCHRONOUS in docker — the
//     endpoint is registered before the IP is allocated. Callers must
//     wait for IP readback (see §5 and `waitForIp`).
//   - `network create` registers NO finalizer; the network outlives
//     individual stacks so resume into a stopped container reattaches
//     to the same bridge id. Cleanup is via `wipe` / `prune`.
//
// Surface:
//   - `ensureNetwork(name, opts)` — idempotent create
//   - `connect(container, network, alias?)` — idempotent attach
//   - `disconnect(container, network)` — idempotent detach
//   - `waitForIp(container, network, opts)` — bounded poll for IP

import { Effect, Schema } from 'effect';

import { DockerHost, DockerSpawner, dockerRun, dockerRunOk } from './client.ts';
import {
	DockerInspectDecodeFailed,
	DockerInspectFailed,
	DaemonUnreachable,
	type DockerRuntimeError,
	ForeignDockerResource,
	NetworkIpReadbackTimeout,
	NetworkOperationFailed,
} from './errors.ts';
import {
	expectedNetworkOwnershipLabels,
	ownershipMismatchDetail,
	renderNetworkLabels,
} from './labels.ts';
import { isAlreadyInNetworkStderr, isDaemonUnreachableStderr, wrapNetworkError } from './wrap.ts';

/** The cross-host shared network name. Architecture-mandated single
 *  bridge per host. Callers can target other networks (per-stack) but
 *  this is the constant for the shared one. */
export const SHARED_NETWORK_NAME = 'devstack';

export interface EnsureNetworkOptions {
	readonly app: string;
	readonly stack: string;
	readonly subnet?: string;
	readonly gateway?: string;
	readonly driver?: 'bridge' | 'host' | 'overlay';
	readonly composeUi?: boolean;
}

interface NetworkInspectFacts {
	readonly id: string;
	readonly labels: Readonly<Record<string, string>>;
}

const readLabels = (raw: unknown): Readonly<Record<string, string>> => {
	if (raw === null || typeof raw !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
};

const NetworkInspectSchema = Schema.Struct({
	Id: Schema.String,
	Labels: Schema.optional(Schema.Unknown),
});

const isNoSuchNetworkStderr = (stderr: string): boolean =>
	/no such network|network .* not found|not found/i.test(stderr);

const inspectNetwork = (
	name: string,
): Effect.Effect<NetworkInspectFacts | null, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('network', ['inspect', name]).pipe(
			Effect.mapError(wrapNetworkError('inspect', name)),
		);
		if (res.exitCode !== 0) {
			if (isNoSuchNetworkStderr(res.stderr)) return null;
			if (isDaemonUnreachableStderr(res.stderr)) {
				return yield* Effect.fail(
					new DaemonUnreachable({
						op: 'docker.network.inspect',
						detail: 'docker daemon unreachable',
					}),
				);
			}
			return yield* Effect.fail(
				new DockerInspectFailed({
					resource: 'network',
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
						resource: 'network',
						name,
						detail: 'inspect returned an empty result',
					}),
				);
			}
			const decoded = Schema.decodeUnknownSync(NetworkInspectSchema)(arr[0]);
			return { id: decoded.Id, labels: readLabels(decoded.Labels) };
		} catch (cause) {
			return yield* Effect.fail(
				new DockerInspectDecodeFailed({
					resource: 'network',
					name,
					detail: 'inspect returned malformed network JSON',
					cause,
				}),
			);
		}
	});

const assertNetworkOwned = (
	name: string,
	facts: NetworkInspectFacts,
	opts: EnsureNetworkOptions,
): Effect.Effect<void, DockerRuntimeError> =>
	Effect.gen(function* () {
		const expected = expectedNetworkOwnershipLabels(opts.app, opts.stack);
		const mismatch = ownershipMismatchDetail(expected, facts.labels);
		if (mismatch !== null) {
			return yield* Effect.fail(
				new ForeignDockerResource({
					resource: 'network',
					name,
					expected,
					actual: facts.labels,
					detail: mismatch,
				}),
			);
		}
	});

// -----------------------------------------------------------------------------
// Create / inspect
// -----------------------------------------------------------------------------

/** Idempotent `docker network create`. Returns the network's id (or
 *  the pre-existing id). Architecture: NO scope finalizer — networks
 *  outlive the supervisor. */
export const ensureNetwork = (
	name: string,
	opts: EnsureNetworkOptions,
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const probe = yield* inspectNetwork(name);
		if (probe !== null) {
			yield* assertNetworkOwned(name, probe, opts);
			return probe.id;
		}
		// Create with full label stamp.
		const labelArgs = renderNetworkLabels(name, opts.app, opts.stack, {
			composeUi: opts.composeUi,
		}).flatMap((l) => ['--label', l]);
		const driverArgs = opts.driver ? ['--driver', opts.driver] : [];
		const subnetArgs = opts.subnet ? ['--subnet', opts.subnet] : [];
		const gatewayArgs = opts.gateway ? ['--gateway', opts.gateway] : [];
		const created = yield* dockerRun('network', [
			'create',
			...driverArgs,
			...subnetArgs,
			...gatewayArgs,
			...labelArgs,
			name,
		]).pipe(Effect.mapError(wrapNetworkError('create', name)));
		return created.stdout.trim();
	}).pipe(Effect.withSpan('runtime.docker.network.ensure'));

// -----------------------------------------------------------------------------
// Connect / disconnect
// -----------------------------------------------------------------------------

/** Idempotent `docker network connect`. Treats "already exists in
 *  network" stderr as success — architecture mandates idempotency on
 *  this verb. */
export const connect = (
	containerNameOrId: string,
	network: string,
	alias?: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const aliasArgs = alias ? ['--alias', alias] : [];
		const res = yield* dockerRunOk('network', [
			'connect',
			...aliasArgs,
			network,
			containerNameOrId,
		]).pipe(Effect.mapError(wrapNetworkError('connect', network)));
		if (res.exitCode === 0) return;
		if (isAlreadyInNetworkStderr(res.stderr)) return;
		// Non-idempotent failure path.
		return yield* Effect.fail(
			new NetworkOperationFailed({ op: 'connect', network, stderr: res.stderr }),
		);
	}).pipe(Effect.withSpan('runtime.docker.network.connect'));

export const disconnect = (
	containerNameOrId: string,
	network: string,
): Effect.Effect<void, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('network', ['disconnect', network, containerNameOrId]).pipe(
			Effect.mapError(wrapNetworkError('disconnect', network)),
		);
		// "is not connected" is also idempotent success on the
		// disconnect side; we treat any non-fatal stderr as success here
		// since the postcondition (not connected) holds.
		if (res.exitCode !== 0 && !/is not connected/i.test(res.stderr)) {
			return yield* Effect.fail(
				new NetworkOperationFailed({ op: 'disconnect', network, stderr: res.stderr }),
			);
		}
	}).pipe(Effect.withSpan('runtime.docker.network.disconnect'));

// -----------------------------------------------------------------------------
// IP readback
// -----------------------------------------------------------------------------

/** Schema of the small JSON slice of `docker inspect` we read for the
 *  network-membership / IP shape. */
const InspectNetworkSettings = Schema.Struct({
	NetworkSettings: Schema.Struct({
		Networks: Schema.Record(
			Schema.String,
			Schema.Struct({
				IPAddress: Schema.optional(Schema.String),
				NetworkID: Schema.optional(Schema.String),
			}),
		),
	}),
});

const DEFAULT_IP_POLL_BUDGET_MILLIS = 3_000;
const DEFAULT_IP_POLL_INTERVAL_MILLIS = 100;

export interface WaitForIpOptions {
	readonly budgetMillis?: number;
	readonly intervalMillis?: number;
}

/** Poll `docker inspect` until the container has a non-empty IP on
 *  `network`. Architecture §5 — async network-connect settle. */
export const waitForIp = (
	containerNameOrId: string,
	network: string,
	opts: WaitForIpOptions = {},
): Effect.Effect<string, DockerRuntimeError, DockerHost | DockerSpawner> => {
	const budget = opts.budgetMillis ?? DEFAULT_IP_POLL_BUDGET_MILLIS;
	const interval = opts.intervalMillis ?? DEFAULT_IP_POLL_INTERVAL_MILLIS;
	return Effect.gen(function* () {
		const start = Date.now();
		while (true) {
			const res = yield* dockerRunOk('inspect', [containerNameOrId]).pipe(
				Effect.mapError(wrapNetworkError('inspect', network)),
			);
			if (res.exitCode === 0) {
				try {
					const arr = JSON.parse(res.stdout) as unknown;
					if (Array.isArray(arr) && arr.length > 0) {
						const decoded = Schema.decodeUnknownSync(InspectNetworkSettings)(arr[0]);
						const slot = decoded.NetworkSettings.Networks[network];
						const ip = slot?.IPAddress;
						if (ip && ip.length > 0) return ip;
					}
				} catch {
					// Malformed — fall through to retry.
				}
			}
			const elapsed = Date.now() - start;
			if (elapsed >= budget) {
				return yield* Effect.fail(
					new NetworkIpReadbackTimeout({
						container: containerNameOrId,
						network,
						waitedMillis: elapsed,
					}),
				);
			}
			yield* Effect.sleep(`${interval} millis`);
		}
	}).pipe(Effect.withSpan('runtime.docker.network.waitForIp'));
};

/** Read out ALL networks + IPs for a container. Used by the contract's
 *  `ContainerHandle.ips`. */
export const readIps = (
	containerNameOrId: string,
): Effect.Effect<ReadonlyArray<string>, DockerRuntimeError, DockerHost | DockerSpawner> =>
	Effect.gen(function* () {
		const res = yield* dockerRunOk('inspect', [containerNameOrId]).pipe(
			Effect.mapError(wrapNetworkError('inspect', containerNameOrId)),
		);
		if (res.exitCode !== 0) return [];
		try {
			const arr = JSON.parse(res.stdout) as unknown;
			if (!Array.isArray(arr) || arr.length === 0) return [];
			const decoded = Schema.decodeUnknownSync(InspectNetworkSettings)(arr[0]);
			const ips: Array<string> = [];
			for (const slot of Object.values(decoded.NetworkSettings.Networks)) {
				if (slot.IPAddress && slot.IPAddress.length > 0) ips.push(slot.IPAddress);
			}
			return ips;
		} catch {
			return [];
		}
	}).pipe(Effect.withSpan('runtime.docker.network.readIps'));
