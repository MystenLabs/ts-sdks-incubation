// Account plugin — Codegenable contribution.
//
// Architecture §6 + 12-account.md "Cross-component references":
// Accounts are a DEV-only, network-AGNOSTIC concept. The account name →
// address map rides the deployment ENVELOPE's `accounts` channel: boot's
// `assembleDeployment` folds this decl's `accounts.ts` aggregate
// projection into `deployment.accounts`, which the generated
// `config-runtime.ts` exposes via `resolveAccounts()`. The decl is
// VALUES-ONLY — it emits NO standalone file and lands no `accounts.ts`
// tree on disk (the dev wallet reads the addresses off the injected
// deployment, not an import).
//
// SAFETY: only the non-secret `name` + `address` reach the deployment.
// No keypair / secret material is ever projected.

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

import { defineSimpleConstExport } from '../internal/codegen-helpers.ts';

/** The typed shape the account decl projects. Per-account record keyed
 *  by name → address. (No `scheme`/`source` — those had no consumer and
 *  the address is the only field the envelope-level `accounts` map carries.) */
export interface AccountBindings {
	readonly name: string;
	readonly address: string;
}

/** Construct the Codegenable contribution. One decl per account.
 *
 *  Values-only: emits NO standalone file. The combined `accounts.ts`
 *  aggregate projection is consumed ONLY by boot's `assembleDeployment`,
 *  which folds it into the deployment envelope's network-agnostic
 *  `accounts` map (name → address). No `accounts.ts` file is written. */
export const makeAccountCodegen = <Name extends string>(parts: {
	readonly name: Name;
	readonly resolved: AccountBindings;
}): CodegenableDecl<`account/${Name}`> =>
	defineSimpleConstExport({
		emitterName: `account/${parts.name}` as `account/${Name}`,
		outputPath: `accounts/${parts.name}.ts`,
		exportName: parts.name,
		value: parts.resolved,
		aggregateOnly: true,
		aggregate: {
			kind: 'account',
			bucket: 'accounts.ts',
			// Pass-through: this decl's exported map already keys by
			// account name, which is the aggregate's merge key.
			project: (exported) => exported,
		},
	});
