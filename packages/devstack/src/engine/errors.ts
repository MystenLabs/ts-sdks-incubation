import { Schema } from 'effect';

import {
	AccountPhases,
	DeepbookPhases,
	ManifestPhases,
	PublishPhases,
	SealPhases,
	SuiPhases,
	WalletAppPhases,
	WalrusPhases,
} from './phases.js';

export class SuiError extends Schema.TaggedErrorClass<SuiError>()('SuiError', {
	// `phase` names the lifecycle step that failed. Closed set in
	// `engine/phases.ts` (`SuiPhases`); add a constant there to introduce
	// a new phase. Optional so callers without a specific phase can still
	// construct the error.
	phase: Schema.optional(Schema.Literals(SuiPhases)),
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
	// `phase` names the account lifecycle step that failed. Closed set
	// in `engine/phases.ts` (`AccountPhases`).
	phase: Schema.Literals(AccountPhases),
	// `account` names the account ref the failure was for. Optional because
	// some failures happen before an account name is resolved.
	account: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class PublishError extends Schema.TaggedErrorClass<PublishError>()('PublishError', {
	// `phase` names the publish pipeline step that failed. Closed set in
	// `engine/phases.ts` (`PublishPhases`). Optional because some failures
	// happen before a specific phase is entered.
	phase: Schema.optional(Schema.Literals(PublishPhases)),
	// `packageName` is the Move package ref whose publish failed. Optional
	// because pipeline errors before the package is resolved.
	packageName: Schema.optional(Schema.String),
	// `sourcePath` is the on-disk path of the Move sources being published.
	// Surfaced in pretty-error for build/scrub failures so the user can
	// jump straight to the failing tree.
	sourcePath: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class HostProcessError extends Schema.TaggedErrorClass<HostProcessError>()(
	'HostProcessError',
	{
		// `phase` is the command string the plugin author passed to
		// `hostScript(...)` (e.g. 'sui move build', 'sui client publish',
		// 'pnpm dev'). Stays `Schema.String` (no closed set) because the
		// value is user-controlled by construction — see `engine/phases.ts`
		// header for the rationale. Optional for the same reason as other
		// phase fields — failures before a phase is entered.
		phase: Schema.optional(Schema.String),
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
	// `phase` names the docker CLI invocation that failed (e.g. 'docker run',
	// 'docker rm', 'docker pull'). Stays `Schema.String` (no closed set)
	// because phases mix CLI verbs with router-internal labels and
	// interpolated network names — see `engine/phases.ts` header for the
	// rationale. Optional because public-facing wrappers re-throw
	// DockerError without a specific phase when they're aggregating a
	// downstream failure under a primitive's own context.
	phase: Schema.optional(Schema.String),
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
	// `phase` names the wallet-app server lifecycle step that failed.
	// Closed set in `engine/phases.ts` (`WalletAppPhases`).
	phase: Schema.Literals(WalletAppPhases),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class ManifestError extends Schema.TaggedErrorClass<ManifestError>()('ManifestError', {
	// `phase` names the manifest lifecycle step that failed. Closed set
	// in `engine/phases.ts` (`ManifestPhases`).
	phase: Schema.Literals(ManifestPhases),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class WalrusError extends Schema.TaggedErrorClass<WalrusError>()('WalrusError', {
	// `phase` names the walrus lifecycle step that failed. Closed set in
	// `engine/phases.ts` (`WalrusPhases`).
	phase: Schema.optional(Schema.Literals(WalrusPhases)),
	// `component` names which walrus subsystem produced the failure
	// (e.g. 'aggregator', 'publisher', 'storage', 'admin'). Optional —
	// component-agnostic phases (e.g. image build) leave it unset.
	component: Schema.optional(Schema.String),
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
	// `phase` names the seal lifecycle step that failed. Closed set in
	// `engine/phases.ts` (`SealPhases`).
	phase: Schema.optional(Schema.Literals(SealPhases)),
	// `keyServer` names the specific key-server instance the failure was
	// for, when seal is running multiple. Optional — single-instance
	// configurations leave it unset.
	keyServer: Schema.optional(Schema.String),
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
	// `phase` names the deepbook lifecycle step that failed. Closed set
	// in `engine/phases.ts` (`DeepbookPhases`).
	phase: Schema.optional(Schema.Literals(DeepbookPhases)),
	// `pool` names the deepbook pool the failure was for. Optional —
	// publish/setup phases that aren't pool-scoped leave it unset.
	pool: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}
