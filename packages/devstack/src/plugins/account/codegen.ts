// Account plugin — Codegenable contribution.
//
// Architecture §6 + 12-account.md "Cross-component references":
// Codegen emits a constant address map keyed by account name so
// downstream code can `import { accounts } from '<staged>/accounts'`
// and read `accounts.alice.address` at the type level.
//
// Distilled-doc tension (12-account.md "publicKey caveat"):
// impersonation accounts have a zero-buffer publicKey — emitting it
// into the codegen bindings would be a type-level lie. The emitted
// shape below carries the `source` discriminator INSTEAD of
// publicKey; consumers branch on `source: 'impersonate'` rather than
// publicKey-truthiness.
//
// SAFETY: the codegen output never emits secret material. Only the
// `name`, `address`, `scheme`, and `source` fields land on disk.
// `sensitive: false` is correct because none of these are secret.

import { Effect } from 'effect';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';

/** The typed shape the emitted file exports. Per-account record keyed
 *  by name. */
export interface AccountBindings {
	readonly name: string;
	readonly address: string;
	readonly scheme: 'ed25519' | 'secp256k1' | 'secp256r1';
	readonly source: 'real' | 'impersonate';
}

/** Construct the Codegenable contribution. One emit per account.
 *
 *  The emitter name is `account/${name}` (literal) so multiple
 *  accounts in a single stack get co-located but typed-distinct
 *  emissions; the codegen orchestrator can fold them into a single
 *  `accounts` namespace at staging time. */
export const makeAccountCodegen = <Name extends string>(parts: {
	readonly name: Name;
	readonly resolved: AccountBindings;
}): CodegenableDecl<`account/${Name}`> => ({
	kind: 'codegenable',
	emitterName: `account/${parts.name}` as `account/${Name}`,
	outputPath: `accounts/${parts.name}.ts`,
	sensitive: false,
	aggregate: {
		kind: 'account',
		bucket: 'accounts.ts',
		// Pass-through: this decl's exported map already keys by
		// account name, which is the aggregate's merge key.
		project: (exported) => exported,
	},
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst(parts.name, parts.resolved);
			return ctx.done();
		}),
});
