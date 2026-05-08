// Pre-flight + host-introspection helpers for the docker daemon.

import { dockerRun } from './run.js';

/** Map `process.arch` to the docker `--platform` value used for builds. */
export function hostDockerPlatform(): string {
	const arch = process.arch;
	if (arch === 'arm64') return 'linux/arm64';
	if (arch === 'x64') return 'linux/amd64';
	throw new Error(`devstack: unsupported host architecture ${arch}`);
}

/** Thrown by {@link requireDockerDaemon} when the Docker daemon is not
 * reachable. Named class so the CLI try/catch can surface a clean
 * stderr message (skipping the stack trace) and exit 1, instead of
 * the user seeing N×red rows in the action grid as each plugin's
 * `getStatus` image-existence probe fails before the real error
 * appears. */
export class DockerDaemonError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DockerDaemonError';
	}
}

/** Pre-flight: verify the Docker daemon is running and responding.
 * Throws {@link DockerDaemonError} with an actionable message if
 * `docker info` fails (engine stopped, socket permission denied,
 * Docker Desktop not started yet). Cheap enough to call once at the
 * top of an action's run() — turns a confusing chain of downstream
 * `docker run` failures into a single clear error before any state
 * mutation. */
export async function requireDockerDaemon(): Promise<void> {
	const result = await dockerRun({
		command: ['info', '--format', '{{.ServerVersion}}'],
	});
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const hint = /permission denied/i.test(stderr)
			? '\n  → Docker socket permissions: add your user to the `docker` group, or run with sudo.'
			: /cannot connect to the docker daemon/i.test(stderr)
				? '\n  → Daemon not running: start Docker Desktop (or `colima start` / `systemctl start docker`).'
				: '';
		throw new DockerDaemonError(
			`docker daemon not reachable (\`docker info\` exited ${result.code}).${hint}\n` +
				(stderr.length > 0 ? `  stderr: ${stderr}\n` : '') +
				'\nRun `devstack doctor` for a full preflight check.',
		);
	}
}
