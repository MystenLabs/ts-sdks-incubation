import { Schema } from 'effect';

export class SuiError extends Schema.TaggedErrorClass<SuiError>()('SuiError', {
	// `phase` names the lifecycle step that failed (e.g. 'network-create',
	// 'postgres-up', 'sui-up', 'ready-probe', 'fetch-chainId'). Optional so
	// callers without a specific phase can still construct the error.
	phase: Schema.optional(Schema.String),
	message: Schema.String,
	// Optional captured streams + exit code from a subprocess (e.g.
	// `docker exec ... pg_isready`) that produced this failure.
	// pretty-error.ts surfaces these when present so subprocess failures
	// are debuggable without re-running.
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

export class AccountError extends Schema.TaggedErrorClass<AccountError>()('AccountError', {
	// `phase` names the account lifecycle step that failed (e.g. 'load-key',
	// 'decode-key', 'write-key', 'fund').
	phase: Schema.Literals(['load-key', 'decode-key', 'write-key', 'fund']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class PublishError extends Schema.TaggedErrorClass<PublishError>()('PublishError', {
	// `stage` names the publish pipeline step that failed (e.g. 'hash', 'scrub',
	// 'build', 'publish-tx', 'parse'). Optional for the same reason as `phase`.
	stage: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class HostProcessError extends Schema.TaggedErrorClass<HostProcessError>()(
	'HostProcessError',
	{
		// `command` names the host command that failed (e.g. 'sui move build',
		// 'sui client publish'). Optional for the same reason as `phase`.
		command: Schema.optional(Schema.String),
		message: Schema.String,
		// Optional captured streams + exit code from the host subprocess that
		// produced this failure. pretty-error.ts surfaces these when present
		// so host-script / host-process failures are debuggable without
		// re-running.
		stderr: Schema.optional(Schema.String),
		stdout: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number),
		cause: Schema.optional(Schema.Defect),
	},
) {}

export class DockerError extends Schema.TaggedErrorClass<DockerError>()('DockerError', {
	// `op` names the docker CLI invocation that failed (e.g. 'docker run',
	// 'docker rm', 'docker pull'). Optional because public-facing wrappers
	// re-throw DockerError without a specific op when they're aggregating a
	// downstream failure under a primitive's own context.
	op: Schema.optional(Schema.String),
	message: Schema.String,
	// `stdout` / `stderr` capture what the docker CLI actually printed before
	// failing. Without these, errors like "Cannot connect to Docker daemon",
	// "image not found", or "port already allocated" land as a generic
	// "docker run produced empty stdout" — debuggable only by re-running
	// the command by hand. Truncated to ~1KB upstream so a verbose pull
	// progress dump doesn't dwarf the rest of the error.
	stdout: Schema.optional(Schema.String),
	stderr: Schema.optional(Schema.String),
	// `exitCode` distinguishes "docker exited 0 but emitted nothing" (e.g.
	// the daemon swallowed the run silently) from "docker exited non-zero
	// with a real error message in stderr". `undefined` means we never got
	// far enough to read it (e.g. spawn itself failed).
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

export class WalletAppError extends Schema.TaggedErrorClass<WalletAppError>()('WalletAppError', {
	// `phase` names the wallet-app server lifecycle step that failed (e.g.
	// 'listen').
	phase: Schema.Literals(['listen']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class ManifestError extends Schema.TaggedErrorClass<ManifestError>()('ManifestError', {
	// `phase` names the manifest lifecycle step that failed (e.g. 'write').
	phase: Schema.Literals(['write']),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class WalrusError extends Schema.TaggedErrorClass<WalrusError>()('WalrusError', {
	// `phase` names the walrus lifecycle step that failed (e.g. 'image',
	// 'network', 'deploy', 'register', 'nodes', 'exchange', 'proxy', 'seed').
	phase: Schema.optional(Schema.String),
	message: Schema.String,
	// Optional captured streams + exit code from a one-shot container that
	// produced this failure. pretty-error.ts surfaces these when present
	// so docker subprocess failures are debuggable without re-running.
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

export class SealError extends Schema.TaggedErrorClass<SealError>()('SealError', {
	// `phase` names the seal lifecycle step that failed (e.g. 'port-alloc',
	// 'image', 'keygen', 'publish', 'register', 'config-render', 'container',
	// 'ready').
	phase: Schema.optional(Schema.String),
	message: Schema.String,
	// Captured streams from a one-shot container that produced this failure.
	// pretty-error.ts surfaces these when present so docker subprocess
	// failures (e.g. seal-cli genkey) are debuggable without re-running.
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

export class DeepbookError extends Schema.TaggedErrorClass<DeepbookError>()('DeepbookError', {
	// `phase` names the deepbook lifecycle step that failed (e.g. 'publish',
	// 'create-pools', 'market-maker-tick').
	phase: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}
