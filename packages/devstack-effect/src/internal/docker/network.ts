// `Docker.networkCreate` — idempotent, Scope-managed bridge networks
// with optional explicit `--subnet` / `--gateway` pins for primitives
// that need per-container `--ip` slots.

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import type { Scope } from 'effect/Scope';
import { DockerError } from '../../primitives/errors.js';
import { Identity } from '../identity.js';
import { composeProjectName, runCapturing, runCapturingOrFail } from './core.js';

export const networkCreate = (
	name: string,
	options?: {
		readonly subnet?: string;
		readonly gateway?: string;
		/** Compose-project label so Docker Desktop groups the network with its containers. */
		readonly composeProject?: string;
	},
): Effect.Effect<string, DockerError, ChildProcessSpawner.ChildProcessSpawner | Identity | Scope> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const identity = yield* Identity;
		// Networks are persistent shared resources — they outlive any
		// individual supervisor process. We deliberately register NO
		// finalizer here: a clean Ctrl-C / SIGTERM should leave the
		// network on disk so the next `pnpm dev` can resume the same
		// containers (which are `docker stop`-ed, not removed). Removing
		// the network on supervisor shutdown orphans the stopped
		// containers — they can't `docker start` back without their
		// network, and recreating a same-named network gives them a
		// different bridge ID. Cleanup is the job of `devstack wipe`,
		// which queries by `devstack.app=…` / `devstack.stack=…` label
		// and removes containers + networks + volumes atomically.
		yield* Effect.annotateCurrentSpan({ 'docker.network': name });

		// Idempotent: if a network with this name already exists (left over
		// from a prior run, which is the EXPECTED case on warm restart),
		// just reuse it.
		const existing = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['network', 'ls', '-q', '--filter', `name=^${name}$`]),
			'docker network ls',
		);
		if (existing.stdout.trim().length > 0) {
			return name;
		}

		// Build the create argv. With a `subnet` we hand docker an explicit
		// IPAM pin (and optional `--gateway`) so sibling containers in the
		// stack can claim fixed IPs via `Docker.run({ ip })`. Without one we
		// fall back to docker's default bridge IPAM.
		//
		// Compose labels mirror what `docker compose up` stamps on a
		// project network — verified via `docker inspect` against a real
		// compose-managed network. Docker Desktop's UI groups the network
		// under the same project entry as the containers when the full
		// label set is present (project + network + version).
		const createArgs: Array<string> = ['network', 'create'];
		const composeProject =
			options?.composeProject ??
			composeProjectName(identity.app, identity.stack, identity.network);
		createArgs.push('--label', `com.docker.compose.project=${composeProject}`);
		createArgs.push('--label', `com.docker.compose.network=${name}`);
		createArgs.push('--label', `com.docker.compose.version=2.0.0`);
		createArgs.push('--label', `devstack.app=${identity.app}`);
		createArgs.push('--label', `devstack.stack=${identity.stack}`);
		if (options?.subnet !== undefined) {
			createArgs.push('--subnet', options.subnet);
			if (options.gateway !== undefined) {
				createArgs.push('--gateway', options.gateway);
			}
		}
		createArgs.push(name);

		yield* runCapturingOrFail(
			spawner,
			ChildProcess.make('docker', createArgs),
			'docker network create',
		);

		return name;
	}).pipe(Effect.withSpan('Docker.networkCreate'));

/**
 * Attach an already-running container to an additional docker network.
 * Idempotent: `docker network connect` exits non-zero with `already
 * exists in network` on a second call, which we swallow so callers
 * (multi-network primitives like walrus storage nodes) can call this
 * unconditionally on every boot cycle without branching on inspect
 * state. Other failures are surfaced as a typed `DockerError`.
 */
export const networkConnect = (
	networkName: string,
	containerId: string,
): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const captured = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['network', 'connect', networkName, containerId]),
			'docker network connect',
		);
		if (captured.exitCode === 0) return;
		const stderr = captured.stderr.toLowerCase();
		// `endpoint with name X already exists in network Y` is the
		// idempotent case — already attached. Anything else is a real
		// failure (network doesn't exist, container gone, daemon error).
		if (stderr.includes('already exists in network') || stderr.includes('already attached')) {
			return;
		}
		return yield* Effect.fail(
			new DockerError({
				op: 'docker network connect',
				message: `failed to connect container ${containerId} to network '${networkName}': ${captured.stderr.trim()}`,
				stdout: captured.stdout,
				stderr: captured.stderr,
				exitCode: captured.exitCode,
			}),
		);
	}).pipe(Effect.withSpan('Docker.networkConnect'));
