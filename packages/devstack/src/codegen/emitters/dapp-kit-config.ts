// DappKitConfigEmitter — emits a partial `createDAppKit(...)` config
// the app's hand-written `dapp-kit.ts` spreads:
//
//   // src/dapp-kit.ts (user code)
//   import { createDAppKit } from '@mysten/dapp-kit-react';
//   import { devstackDappKitConfig } from './generated/dapp-kit-config.js';
//
//   export const { dAppKit } = createDAppKit({
//     ...devstackDappKitConfig,
//     // app-specific overrides
//   });
//
// What's in the config:
//   - `defaultNetwork` / `networks` — the network the supervisor pinned.
//   - `createClient(network)` — a `SuiGrpcClient` factory with the
//     resolved RPC URL + MVR overrides for every `Package(...)` that
//     emitted an `mvrPlaceholder`.
//   - `walletInitializers` — the devstack burner-wallet adapter wired
//     up against the resolved manifest. Apps can extend with their
//     own initializers in the spread.
//
// The emitter generates static TS — no runtime manifest read. The
// values come from `gatherManifest()` at emit time. Apps stay free of
// `@mysten-incubation/devstack` at runtime (the generated module
// imports only `@mysten/sui`, `@mysten/dapp-kit-core` / `-react`, and
// `@mysten-incubation/dev-wallet`).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';
import { Extras, resolveExtras } from '../../runtime/extras.js';
import { gatherManifest } from '../../runtime/service.js';
import { CodegenError } from '../errors.js';
import { defineEmitter, type Emitter } from '../define-emitter.js';

export interface DappKitConfigEmitterOptions {
	/** Enable the burner-wallet adapter wiring. Defaults to `true`.
	 *  Set `false` to emit a config that wires only the user's own
	 *  wallets. */
	readonly enableBurnerWallet?: boolean;
}

// The generated config imports `SuiGrpcClient` directly from
// `@mysten/sui/grpc` — its `createClient` constructs the client. The
// dapp-kit flavor (core vs react) is selected by what the USER imports
// in their hand-written `dapp-kit.ts` (`createDAppKit` lives in both
// `@mysten/dapp-kit-core` and `@mysten/dapp-kit-react`), so the
// generated module is flavor-neutral and we no longer pick imports
// here.

const writeIfChanged = (outputPath: string, contents: string): Effect.Effect<void, CodegenError> =>
	Effect.tryPromise({
		try: async () => {
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			let existing: string | undefined;
			try {
				existing = await fs.readFile(outputPath, 'utf-8');
			} catch {
				// missing — fall through and write
			}
			if (existing === contents) return;
			await fs.writeFile(outputPath, contents, 'utf-8');
		},
		catch: (cause) =>
			new CodegenError({
				emitter: 'dapp-kit-config',
				phase: 'write',
				message: `failed to write ${outputPath}: ${String(cause)}`,
				cause,
			}),
	});

const renderConfig = (args: {
	network: string;
	rpcUrl: string;
	mvrOverrides: ReadonlyArray<readonly [string, string]>;
	wallet: { url: string; alternates?: ReadonlyArray<string> } | undefined;
	enableBurnerWallet: boolean;
}): string => {
	const mvrLines = args.mvrOverrides.map(
		([placeholder, id]) => `\t${JSON.stringify(placeholder)}: ${JSON.stringify(id)},`,
	);
	const mvrBlock = mvrLines.length === 0 ? '{}' : `{\n${mvrLines.join('\n')}\n}`;

	// Narrow input for `createDevstackAdapterFromManifest` — the adapter
	// only consumes `app.wallet.{url, alternates}`. We bake it in as a
	// JSON literal so the generated module doesn't need to import the
	// runtime devstack helpers. Apps with no `Wallet(...)` in their
	// stack get `app: {}` and the adapter returns `null` (no burner
	// wallet wiring); apps that DO declare a wallet endpoint get its
	// URL + paired-URL surfaced here.
	const adapterManifest: { app: { wallet?: { url: string; alternates?: ReadonlyArray<string> } } } =
		args.wallet !== undefined ? { app: { wallet: args.wallet } } : { app: {} };

	const adapterBlock = args.enableBurnerWallet
		? `import { devWalletInitializer, type DevWalletInitializerConfig } from '@mysten-incubation/dev-wallet';
import {
\tcreateDevstackAdapterFromManifest,
\ttype DevstackAdapterManifest,
} from '@mysten-incubation/dev-wallet/adapters';

const adapterManifest: DevstackAdapterManifest = ${JSON.stringify(adapterManifest, null, '\t')};
const devstackAdapter = createDevstackAdapterFromManifest(adapterManifest);

/** Build a devstack burner-wallet initializer with custom options
 *  (e.g. \`{ mountUI: false }\` for headless production bundles).
 *  Returns \`null\` when the manifest has no accounts the adapter can
 *  bind to. */
export const devstackWalletInitializer = (
\topts: Omit<DevWalletInitializerConfig, 'adapters'> = {},
): ReturnType<typeof devWalletInitializer> | null =>
\tdevstackAdapter
\t\t? devWalletInitializer({ ...opts, adapters: [devstackAdapter] })
\t\t: null;

const defaultWalletInitializer = devstackWalletInitializer();
const walletInitializers = defaultWalletInitializer ? [defaultWalletInitializer] : [];`
		: `const walletInitializers: Array<never> = [];`;

	return `// Generated by @mysten-incubation/devstack — do not edit by hand.
// Re-run \`pnpm dev\` (or the devstack supervisor that emitted this) to
// regenerate.

import { SuiGrpcClient } from '@mysten/sui/grpc';
${adapterBlock}

const network = ${JSON.stringify(args.network)} as const;
const rpcUrl = ${JSON.stringify(args.rpcUrl)};
const mvrOverrides: Record<string, string> = ${mvrBlock};

/** Partial \`createDAppKit(...)\` config. Spread into your hand-written
 *  \`dapp-kit.ts\` (alongside any app-specific overrides) and pass to
 *  \`createDAppKit\` from \`@mysten/dapp-kit-core\` / \`-react\`. */
export const devstackDappKitConfig = {
\tdefaultNetwork: network,
\t// Mutable tuple (no \`as const\`): dapp-kit's \`CreateDAppKitOptions.networks\`
\t// type is invariant on its element type, so a \`readonly\` tuple fails the
\t// assignability check at the user's \`createDAppKit({ ...devstackDappKitConfig })\`
\t// call site.
\tnetworks: [network] as [typeof network],
\tcreateClient: () =>
\t\tnew SuiGrpcClient({
\t\t\tnetwork,
\t\t\tbaseUrl: rpcUrl,
\t\t\tmvr:
\t\t\t\tObject.keys(mvrOverrides).length > 0
\t\t\t\t\t? { overrides: { packages: mvrOverrides } }
\t\t\t\t\t: undefined,
\t\t}),
\twalletInitializers,
};
`;
};

/** Build a `DappKitConfigEmitter` plug-in instance. Drop into
 *  `Codegen({ emitters: [DappKitConfigEmitter()] })` or — typically —
 *  let `Codegen()`'s defaults register it. */
export const DappKitConfigEmitter = (opts: DappKitConfigEmitterOptions = {}): Emitter => {
	const resolved = {
		enableBurnerWallet: opts.enableBurnerWallet ?? true,
	} as const;
	return defineEmitter({
		name: 'dapp-kit-config',
		emit: (ctx) =>
			Effect.gen(function* () {
				const extrasInput = yield* Extras;
				const extras = yield* resolveExtras(extrasInput);
				const data = yield* gatherManifest(extras);

				const sui = data.services.sui;
				if (sui === undefined) {
					// No sui service yet — skip emitting; next supervisor cycle
					// will catch up once sui-localnet is up. Emitting against
					// no RPC would produce a file that fails at runtime.
					yield* Effect.logWarning(
						`DappKitConfigEmitter: skipping emit — no sui service in manifest yet. ` +
							`Will retry on the next codegen cycle.`,
					);
					return;
				}
				const mvrOverrides: Array<readonly [string, string]> = Object.values(data.packages)
					.flatMap((p) => (p.mvr !== undefined ? [[p.mvr, p.id] as const] : []))
					.sort(([a], [b]) => a.localeCompare(b));

				const contents = renderConfig({
					network: sui.network,
					rpcUrl: sui.rpc.url,
					mvrOverrides,
					wallet: data.app.wallet,
					enableBurnerWallet: resolved.enableBurnerWallet,
				});

				yield* writeIfChanged(path.join(ctx.outputDir, 'dapp-kit-config.ts'), contents);
			}),
	});
};
