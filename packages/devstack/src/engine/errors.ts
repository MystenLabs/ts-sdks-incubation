import { Schema } from 'effect';

import {
	AccountPhases,
	DeepbookIndexerPhases,
	DeepbookPhases,
	DeepbookServerPhases,
	ManifestPhases,
	PostgresPhases,
	PublishPhases,
	PythPhases,
	SealPhases,
	SuiPhases,
	WalletAppPhases,
	WalrusPhases,
} from './phases.js';

/**
 * Raised when a caller invokes a `SuiGrpcClient` method that is not
 * supported by `sui-fork` (R1 / R3 / R11 mitigations).
 *
 * `surface` names the unsupported method (e.g. `'getBalance'`,
 * `'listBalances'`, `'getCoinInfo'`, `'simulate_transaction'`). The
 * fork's `sui_fork::store` implementation panics (`todo!()`) on these
 * paths — see `crates/sui-fork/src/store.rs:1198,1206,1214`. We wrap
 * the client with a Proxy in `buildFork` that throws this error
 * BEFORE the wire call so the fork process stays up.
 *
 * `hint` carries a one-line workaround (e.g. for `getBalance`: "use
 * `client.core.listCoins({ owner, coinType })` and sum the response").
 */
export class ForkUnsupportedError extends Schema.TaggedErrorClass<ForkUnsupportedError>()(
	'ForkUnsupportedError',
	{
		surface: Schema.String,
		message: Schema.String,
		hint: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect),
	},
) {}

/**
 * Raised when the on-disk fork meta or seed manifest disagrees with the
 * caller's current configuration (R6 mitigation).
 *
 * `sui-fork` writes a write-once `seed_manifest.json` on first boot
 * (`crates/sui-fork/src/seed.rs:128,144,153`). Re-booting the same data
 * dir with a different `--address` / `--object` / `--checkpoint` / `--network`
 * set fails inside the binary with a non-actionable Rust panic message.
 *
 * Devstack mirrors that contract at a higher layer: `apply` writes
 * `.devstack/stacks/<stack>/sui-fork/meta.json` on first boot of a fork
 * stack with a `configHash` of the relevant `SuiForkOptions` fields, and
 * compares the current config's hash against the on-disk hash on every
 * subsequent boot. A mismatch raises this error with an actionable
 * "run `devstack wipe --keep-upstream-cache && devstack apply`" recipe
 * so the user knows the resolution path.
 *
 * `metaPath` carries the on-disk meta.json path; `previous` / `current`
 * carry the disagreeing config snapshots (upstream / checkpoint /
 * config-hash digest) so the CLI's typed-catch branch can render a
 * structured diff.
 */
export class SeedManifestMismatchError extends Schema.TaggedErrorClass<SeedManifestMismatchError>()(
	'SeedManifestMismatchError',
	{
		metaPath: Schema.String,
		message: Schema.String,
		previous: Schema.optional(
			Schema.Struct({
				upstream: Schema.optional(Schema.String),
				checkpoint: Schema.optional(Schema.Number),
				configHash: Schema.optional(Schema.String),
			}),
		),
		current: Schema.optional(
			Schema.Struct({
				upstream: Schema.optional(Schema.String),
				checkpoint: Schema.optional(Schema.Number),
				configHash: Schema.optional(Schema.String),
			}),
		),
		cause: Schema.optional(Schema.Defect),
	},
) {}

/**
 * Raised when a plugin variant that requires capabilities `sui-fork`
 * doesn't provide is composed against a fork-mode `Sui()` (D5
 * mitigation; Phase 3 P3.5).
 *
 * Today the local-cluster variants of Walrus + Seal need full JSON-RPC,
 * a live Sui chain client baked into their binaries, and (for Walrus)
 * GraphQL — none of which `sui-fork` exposes. Composing
 * `walrusLocalCluster()` or `sealLocalKeygen()` on a `*-fork` network
 * therefore fails at factory time with this error, rather than letting
 * the supervisor get partway up before the underlying binary blows up
 * with an unrelated chain-client / RPC mismatch.
 *
 * `variant` names the offending factory (e.g. `'walrusLocalCluster'`,
 * `'sealLocalKeygen'`); `network` carries the offending `*-fork`
 * literal; `hint` is a one-line workaround pointing at the
 * known-deployment alternative (`Walrus()` / `Seal()` on fork mode
 * auto-pick that path).
 *
 * Phase 5 (D5 follow-up) explores putting a GraphQL indexer in front of
 * the fork to unlock the local-cluster paths; once that lands, this
 * error becomes the structured signal that the user is composing an
 * older, non-shimmed variant.
 */
export class ForkIncompatibleError extends Schema.TaggedErrorClass<ForkIncompatibleError>()(
	'ForkIncompatibleError',
	{
		variant: Schema.String,
		network: Schema.String,
		message: Schema.String,
		hint: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect),
	},
) {}

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
	// Phase 4 — margin extensions. `marginAsset` names the margin pool's
	// asset (e.g. `'USDC'`, `'SUI'`) when a margin-side failure is
	// asset-scoped (`new_coin_type_data_from_currency`, `create_margin_pool`).
	// `feed` carries the Pyth feed hex id when a margin failure resolves
	// down to an unknown / mis-pinned price feed. Both optional — non-
	// margin phases leave them unset.
	marginAsset: Schema.optional(Schema.String),
	feed: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class PythError extends Schema.TaggedErrorClass<PythError>()('PythError', {
	// `phase` names the pyth lifecycle step that failed. Closed set in
	// `engine/phases.ts` (`PythPhases`).
	phase: Schema.optional(Schema.Literals(PythPhases)),
	// `feed` names the specific Pyth feed (mainnet hex id) the failure
	// was for. Optional — publish/setup phases that aren't feed-scoped
	// leave it unset.
	feed: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

export class PostgresError extends Schema.TaggedErrorClass<PostgresError>()('PostgresError', {
	// `phase` names the postgres lifecycle step that failed. Closed set
	// in `engine/phases.ts` (`PostgresPhases`).
	phase: Schema.optional(Schema.Literals(PostgresPhases)),
	// `database` names the specific logical database (e.g. `'deepbook'`)
	// the failure was for. Optional.
	database: Schema.optional(Schema.String),
	message: Schema.String,
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

export class DeepbookIndexerError extends Schema.TaggedErrorClass<DeepbookIndexerError>()(
	'DeepbookIndexerError',
	{
		phase: Schema.optional(Schema.Literals(DeepbookIndexerPhases)),
		message: Schema.String,
		stderr: Schema.optional(Schema.String),
		stdout: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number),
		cause: Schema.optional(Schema.Defect),
	},
) {}

export class DeepbookServerError extends Schema.TaggedErrorClass<DeepbookServerError>()(
	'DeepbookServerError',
	{
		// `phase` names the deepbook-server lifecycle step that failed.
		// Closed set in `engine/phases.ts` (`DeepbookServerPhases`).
		phase: Schema.optional(Schema.Literals(DeepbookServerPhases)),
		message: Schema.String,
		stderr: Schema.optional(Schema.String),
		stdout: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number),
		cause: Schema.optional(Schema.Defect),
	},
) {}
