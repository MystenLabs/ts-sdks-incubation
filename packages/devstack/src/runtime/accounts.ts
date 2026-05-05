// Account resolver. Walks `DevstackConfig.accounts` against the active
// network, materializes a `Signer` per account, and returns an
// `AccountsContext` plumbed through `ctx.accounts.<name>` inside actions.
//
// Resolution per (account, network):
//   1. `spec[network]` if set;
//   2. `spec.default` if set;
//   3. on localnet, an implicit `generatedKeypair()` factory that
//      loads-or-creates an Ed25519 key under `<stackDir>/.keys/<name>.key`;
//   4. otherwise, the resolver records a per-account error to surface on
//      `get(name)` — the rest of the action graph keeps running so a
//      misconfigured live-net signer doesn't poison the localnet path.
//
// Errors raised by factory invocation are also captured per-account and
// re-thrown lazily on first `get()`. Missing-name lookups throw with a
// listing of declared accounts so a typo is obvious.

import type { Signer } from '@mysten/sui/cryptography';
import type {
	AccountFactory,
	AccountFactoryContext,
	AccountSpec,
	AccountsConfig,
	AccountsContext,
	Network,
} from '../core/types.js';
import { generatedKeypair } from '../helpers/signers.js';

interface ResolveAccountsOptions {
	specs: AccountsConfig;
	appDir: string;
	stack: string;
	network: Network;
	/** Best-effort; pass an empty string when the active network's RPC
	 * isn't known yet (supervisor startup before `sui-rpc` is registered). */
	rpcUrl: string;
}

export function resolveAccounts(opts: ResolveAccountsOptions): AccountsContext {
	const specs = normalizeAccountsConfig(opts.specs);
	const resolved = new Map<string, Signer>();
	const errors = new Map<string, Error>();

	for (const [name, spec] of Object.entries(specs)) {
		const ctx: AccountFactoryContext = {
			accountName: name,
			appDir: opts.appDir,
			stack: opts.stack,
			network: opts.network,
			rpcUrl: opts.rpcUrl,
		};
		try {
			const signer = materialize(name, spec, ctx);
			if (signer instanceof Promise) {
				// Async factories aren't supported in eager resolution today —
				// the built-in factories all run synchronously and async-only
				// factories (e.g. KMS) would need a separate lazy path. Capture
				// as an error so it surfaces on `get(name)` rather than
				// silently storing an unresolved promise.
				errors.set(
					name,
					new Error(
						`account '${name}': async factory unsupported in eager resolveAccounts; ` +
							'wrap the call in a sync closure or land an async resolver.',
					),
				);
				continue;
			}
			resolved.set(name, signer);
		} catch (err) {
			errors.set(name, err instanceof Error ? err : new Error(String(err)));
		}
	}

	const declaredNames = Object.keys(specs);

	return {
		get(name: string): Signer {
			const captured = errors.get(name);
			if (captured !== undefined) throw captured;
			const signer = resolved.get(name);
			if (signer !== undefined) return signer;
			if (declaredNames.length === 0) {
				throw new Error(
					`accounts.get('${name}'): no accounts declared. Add ` +
						`\`accounts: ['${name}']\` to your devstack config.`,
				);
			}
			throw new Error(
				`accounts.get('${name}'): unknown account. Declared: ${declaredNames.join(', ')}.`,
			);
		},
		has(name: string): boolean {
			return resolved.has(name) || errors.has(name);
		},
		names(): string[] {
			return declaredNames;
		},
	};
}

/** Normalize the two `AccountsConfig` forms to the canonical
 * record-of-AccountSpec shape used internally. */
function normalizeAccountsConfig(specs: AccountsConfig): Record<string, AccountSpec> {
	if (Array.isArray(specs)) {
		const out: Record<string, AccountSpec> = {};
		for (const name of specs) out[name] = {};
		return out;
	}
	return specs as Record<string, AccountSpec>;
}

function materialize(
	name: string,
	spec: AccountSpec,
	ctx: AccountFactoryContext,
): Signer | Promise<Signer> {
	const slot = pickSlot(spec, ctx.network);
	if (slot !== undefined) return invokeSlot(slot, ctx);
	if (ctx.network === 'localnet') return invokeSlot(generatedKeypair(), ctx);
	throw new Error(
		`account '${name}': no factory configured for network '${ctx.network}' ` +
			'(and no `default` slot). Add a per-network entry — e.g. ' +
			`\`accounts: { ${name}: { ${ctx.network}: cliSigner({ alias: '...' }) } }\`.`,
	);
}

function pickSlot(spec: AccountSpec, network: Network): Signer | AccountFactory | undefined {
	const slot = spec[network];
	if (slot !== undefined) return slot;
	if (spec.default !== undefined) return spec.default;
	return undefined;
}

function invokeSlot(
	slot: Signer | AccountFactory,
	ctx: AccountFactoryContext,
): Signer | Promise<Signer> {
	if (typeof slot === 'function') return slot(ctx);
	return slot;
}
