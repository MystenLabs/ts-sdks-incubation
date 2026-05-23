import { Data } from 'effect';

import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

export interface HostServiceConfigError extends ConfigIssue {
	readonly _tag: 'HostServiceConfigError';
	readonly serviceName: string;
}

const makeHostServiceConfigError = defineConfigError('HostServiceConfigError');

export const hostServiceConfigError = (
	serviceName: string,
	issue: ConfigIssue,
): HostServiceConfigError => ({
	...makeHostServiceConfigError(issue),
	serviceName,
});

export class HostServiceAcquireError extends Data.TaggedError('HostServiceAcquireError')<{
	readonly serviceName: string;
	readonly cwd: string;
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly phase: 'allocate-port' | 'spawn' | 'ready' | 'exit';
	readonly message: string;
	readonly exitCode?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly cause?: unknown;
}> {}

export type HostServiceError = HostServiceConfigError | HostServiceAcquireError;

export const HOST_SERVICE_ERROR_TAGS = [
	'HostServiceConfigError',
	'HostServiceAcquireError',
] as const;
