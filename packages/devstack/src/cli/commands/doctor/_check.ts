// Shared types + orchestrator for `devstack doctor`'s preflight checks.
//
// Every check is a small producer that returns a `Check` record. The
// orchestrator (`renderChecks`) handles the per-check output, the
// `--json` envelope, and the "any required failed → non-zero exit"
// contract once instead of once per check.

import { Console, Effect, FileSystem } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import {
	collectInventory,
	renderInventoryRow,
	renderTotals,
	totalsFor,
} from '../../../engine/docker/inventory.js';
import { Registry } from '../../../engine/registry.js';
import {
	emitEnvelope,
	errorEnvelope,
	successEnvelope,
} from '../../envelope.js';
import { EX_UNAVAILABLE } from '../../exit-codes.js';

export interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly detail?: string;
}

const renderCheck = (c: Check): string => {
	const tag = c.ok ? '✓' : c.required ? '✗' : '!';
	const reqTag = c.required ? '' : ' (informational)';
	const detail = c.detail !== undefined ? ` — ${c.detail}` : '';
	return `  ${tag} ${c.name}${reqTag}${detail}`;
};

/** Audit-line records the orchestrator emits underneath the lock check
 *  rows so the operator can see exactly which paths were removed. */
export interface AuditLine {
	readonly path: string;
	readonly extra?: string;
}

export interface RenderChecksArgs {
	readonly checks: ReadonlyArray<Check>;
	readonly useJson: boolean;
	readonly startedAt: number;
	/** When true, the inventory section is emitted after the checks
	 *  block (text) and inventory rows are attached to the success
	 *  envelope (json). When false (docker check failed), the section
	 *  is skipped. */
	readonly includeInventory: boolean;
	/** Optional audit lines emitted right after the checks block in
	 *  text mode. One inner array per anchor (e.g. state-store locks,
	 *  then move-git locks). Each line renders as `      └─ {path}{extra}`. */
	readonly auditLines?: ReadonlyArray<ReadonlyArray<AuditLine>>;
}

/** Run the per-check producer table → emit. Returns clean on success;
 *  fails with an Error when at least one required check failed (so the
 *  CLI runner exits non-zero). The JSON envelope shape and exit-code
 *  contract here are the Phase A contract — do not change. */
export const renderChecks = ({
	checks,
	useJson,
	startedAt,
	includeInventory,
	auditLines,
}: RenderChecksArgs): Effect.Effect<
	void,
	Error,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Registry
> =>
	Effect.gen(function* () {
		const failedRequired = checks.filter((c) => c.required && !c.ok);

		if (useJson) {
			const rows = includeInventory ? yield* collectInventory() : [];
			if (failedRequired.length > 0) {
				yield* emitEnvelope(
					errorEnvelope({
						command: 'doctor',
						error: {
							code: 'PREFLIGHT_FAILED',
							exitCode: EX_UNAVAILABLE,
							message: `${failedRequired.length} required check${failedRequired.length === 1 ? '' : 's'} failed`,
							context: {
								failed: failedRequired.map((c) => ({ name: c.name, detail: c.detail })),
							},
						},
						elapsedMs: Date.now() - startedAt,
					}),
				);
				return yield* Effect.fail(new Error('doctor: required checks failed'));
			}
			yield* emitEnvelope(
				successEnvelope({
					command: 'doctor',
					data: {
						checks: checks.map((c) => ({
							name: c.name,
							ok: c.ok,
							required: c.required,
							detail: c.detail,
						})),
						inventory: rows.map((r) => ({
							app: r.app,
							stack: r.stack,
							classification: r.classification,
							containers: r.containers.length,
							networks: r.networks.length,
							volumes: r.volumes.length,
							stateDirs: r.stateDirs,
							runningPid: r.runningPid,
						})),
					},
					elapsedMs: Date.now() - startedAt,
				}),
			);
			return;
		}

		yield* Console.log('Checks');
		for (const c of checks) {
			yield* Console.log(renderCheck(c));
		}
		if (auditLines !== undefined) {
			for (const block of auditLines) {
				for (const line of block) {
					const extra = line.extra !== undefined ? ` ${line.extra}` : '';
					yield* Console.log(`      └─ ${line.path}${extra}`);
				}
			}
		}

		if (includeInventory) {
			yield* Console.log('');
			yield* Console.log('Inventory');
			const rows = yield* collectInventory();
			if (rows.length === 0) {
				yield* Console.log('  (no devstack-labelled resources)');
			} else {
				for (const row of rows) {
					yield* Console.log(renderInventoryRow(row));
				}
				yield* Console.log('');
				yield* Console.log(renderTotals(totalsFor(rows)));
				// Compact running / repo-gone summary line. Only mentions
				// repo-gone when there's at least one — otherwise the
				// hint below is the only call to action and the line
				// stays quiet.
				const runningCount = rows.filter((r) => r.runningPid !== undefined).length;
				const repoGoneCount = rows.filter((r) => r.classification === 'repo-gone').length;
				yield* Console.log(
					`Total: ${rows.length} stack${rows.length === 1 ? '' : 's'}. ${runningCount} running. ${repoGoneCount} with missing repo directory.`,
				);
				if (repoGoneCount > 0) {
					yield* Console.log('');
					yield* Console.log(
						`Run \`devstack prune --repo-gone --yes\` to clean ${repoGoneCount} stack${repoGoneCount === 1 ? '' : 's'} whose project is gone.`,
					);
				}
			}
		}

		if (failedRequired.length > 0) {
			yield* Console.log('');
			yield* Console.log(`${failedRequired.length} required check(s) failed.`);
			return yield* Effect.fail(new Error('doctor: required checks failed'));
		}
	});
