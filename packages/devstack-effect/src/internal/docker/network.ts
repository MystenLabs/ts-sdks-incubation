// `Docker.networkCreate` — idempotent, Scope-managed bridge networks
// with optional explicit `--subnet` / `--gateway` pins for primitives
// that need per-container `--ip` slots.

import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { addFinalizer, type Scope } from 'effect/Scope';
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
		const scope = yield* Effect.scope;
		yield* Effect.annotateCurrentSpan({ 'docker.network': name });

		// Idempotent: if a network with this name already exists (left over
		// from a prior run that didn't clean up), reuse it instead of
		// failing. Same finalizer wires up either way.
		const existing = yield* runCapturing(
			spawner,
			ChildProcess.make('docker', ['network', 'ls', '-q', '--filter', `name=^${name}$`]),
			'docker network ls',
		);
		if (existing.stdout.trim().length > 0) {
			yield* addFinalizer(
				scope,
				Effect.uninterruptible(
					spawner.exitCode(ChildProcess.make('docker', ['network', 'rm', name])).pipe(Effect.ignore),
				),
			);
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
			options?.composeProject ?? composeProjectName(identity.app, identity.stack);
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

		yield* addFinalizer(
			scope,
			Effect.uninterruptible(
				spawner.exitCode(ChildProcess.make('docker', ['network', 'rm', name])).pipe(
					// `network rm` fails with "active endpoints" if any container
					// is still attached. Reverse-topo shutdown order normally
					// drains them first, but a process killed mid-cycle can race.
					// Leave the network for `docker network prune` to GC rather
					// than wedge teardown.
					Effect.ignore,
				),
			),
		);

		return name;
	}).pipe(Effect.withSpan('Docker.networkCreate'));
