import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { DockerHostShape } from '../../runtime/docker/client.ts';

export const ROUTER_PROFILE_VERSION = 1;

export interface RouterProfile {
	readonly version: typeof ROUTER_PROFILE_VERSION;
	readonly id: string;
	readonly userId: string;
	readonly dockerContextId: string;
	readonly stateDir: string;
	readonly dispatchDir: string;
	readonly containerName: string;
	readonly networkName: string;
	readonly bootstrapLockFile: string;
	readonly dispatchLockFile: string;
}

export interface RouterProfileOptions {
	readonly userId: string;
	readonly dockerContextId: string;
	readonly stateRoot?: string;
	readonly namePrefix?: string;
}

export interface DefaultRouterProfileOptions {
	readonly dockerHost?: DockerHostShape;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly stateRoot?: string;
}

const shortHash = (input: string): string =>
	createHash('sha256').update(input).digest('hex').slice(0, 12);

const safeSegment = (input: string): string =>
	input
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, '-')
		.replace(/^[^a-z0-9]+/, '')
		.slice(0, 24)
		.replace(/[-_.]+$/, '');

export const makeRouterProfile = (options: RouterProfileOptions): RouterProfile => {
	const prefix = options.namePrefix ?? 'devstack';
	const fingerprint = shortHash(`${options.userId}\0${options.dockerContextId}`);
	const userSegment = safeSegment(options.userId) || 'user';
	const id = `${userSegment}-${fingerprint}`;
	const stateRoot = options.stateRoot ?? join(homedir(), '.devstack', 'router');
	const stateDir = join(stateRoot, id);
	return {
		version: ROUTER_PROFILE_VERSION,
		id,
		userId: options.userId,
		dockerContextId: options.dockerContextId,
		stateDir,
		dispatchDir: join(stateDir, 'dispatch'),
		containerName: `${prefix}-router-${fingerprint}`,
		networkName: `${prefix}-router-${fingerprint}`,
		bootstrapLockFile: join(stateDir, 'locks', 'bootstrap.lock'),
		dispatchLockFile: join(stateDir, 'locks', 'dispatch.lock'),
	};
};

export const currentRouterUserId = (): string => {
	if (typeof process.getuid === 'function') return `uid-${process.getuid()}`;
	try {
		return `user-${userInfo().username}`;
	} catch {
		return `user-${process.env.USER ?? 'unknown'}`;
	}
};

const dockerContextFromCli = (
	bin: string,
	env: Readonly<Record<string, string | undefined>>,
): string | null => {
	try {
		const out = execFileSync(bin, ['context', 'show'], {
			encoding: 'utf8',
			timeout: 1000,
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, ...env },
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
};

const dockerContextFromConfig = (
	env: Readonly<Record<string, string | undefined>>,
): string | null => {
	const configDir = env.DOCKER_CONFIG ?? join(homedir(), '.docker');
	try {
		const raw = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as {
			readonly currentContext?: unknown;
		};
		return typeof raw.currentContext === 'string' && raw.currentContext.trim().length > 0
			? raw.currentContext.trim()
			: null;
	} catch {
		return null;
	}
};

const dockerDaemonIdFromCli = (
	bin: string,
	env: Readonly<Record<string, string | undefined>>,
): string | null => {
	try {
		const out = execFileSync(bin, ['info', '--format', '{{.ID}}'], {
			encoding: 'utf8',
			timeout: 1000,
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, ...env },
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
};

export const resolveDockerContextId = (
	dockerHost: DockerHostShape = {},
	env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
	const bin = dockerHost.bin ?? 'docker';
	const host = dockerHost.dockerHost ?? env.DOCKER_HOST ?? 'default';
	const dockerEnv: Record<string, string | undefined> = {
		...(env.DOCKER_CONTEXT === undefined ? {} : { DOCKER_CONTEXT: env.DOCKER_CONTEXT }),
		...(host === 'default' ? {} : { DOCKER_HOST: host }),
	};
	const envContext = env.DOCKER_CONTEXT?.trim();
	const context =
		envContext && envContext.length > 0
			? envContext
			: (dockerContextFromConfig(env) ?? dockerContextFromCli(bin, dockerEnv));
	if (context !== null) return `context:${context}|host:${host}`;
	const daemonId = dockerDaemonIdFromCli(bin, dockerEnv);
	if (daemonId !== null) return `daemon:${daemonId}`;
	return `context:default|host:${host}`;
};

export const makeDefaultRouterProfile = (
	options: DefaultRouterProfileOptions = {},
): RouterProfile =>
	makeRouterProfile({
		userId: currentRouterUserId(),
		dockerContextId: resolveDockerContextId(options.dockerHost, options.env),
		...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
	});
