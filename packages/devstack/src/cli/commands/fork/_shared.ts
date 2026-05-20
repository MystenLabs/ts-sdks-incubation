// Shared plumbing for `devstack fork <sub>` subcommands — the
// resolve-stack → manifest-discover → make-client → wrapForkRpc dance
// every admin subcommand repeats, plus the `--stack` / `--json` flag
// definitions. Audit E20 (notes/stack-simplification-audit.md:231).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Effect, FileSystem, Option, Path } from 'effect';
import { Flag } from 'effect/unstable/cli';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { readStackContext } from '../../../runtime/read-stack-context.js';
import { AlreadyReportedError, failAlreadyReported } from '../../already-reported.js';
import { resolveStack } from '../../stack-resolution.js';

export const stackFlag = Flag.string('stack').pipe(
	Flag.withDescription('Stack to target (default: active stack, or "main")'),
	Flag.optional,
);

export const jsonFlag = Flag.boolean('json').pipe(
	Flag.withDescription('Emit machine-readable JSON instead of a human summary'),
	Flag.withDefault(false),
);

// ---------------------------------------------------------------------------
// Runtime context — manifest lookup + upstream classification.
// ---------------------------------------------------------------------------

export interface ForkRuntimeContext {
	readonly stack: string;
	readonly rpcUrl: string;
	readonly upstream: 'mainnet' | 'testnet' | 'devnet';
	readonly chainId?: string;
}

const networkToUpstream = (network: string): 'mainnet' | 'testnet' | 'devnet' | undefined => {
	if (network === 'mainnet-fork' || network === 'mainnet') return 'mainnet';
	if (network === 'testnet-fork' || network === 'testnet') return 'testnet';
	if (network === 'devnet-fork' || network === 'devnet') return 'devnet';
	return undefined;
};

export const resolveForkRuntimeCtx = (stack: string) =>
	readStackContext({ stack }).pipe(
		Effect.flatMap((ctx) => {
			const sui = ctx.sui;
			if (sui === undefined) {
				return failAlreadyReported(
					`devstack fork: no fork stack found for stack='${stack}'. Looked for ` +
						`a manifest.json under .devstack/stacks/${stack}/ with services.sui.rpc.url set. ` +
						`Run \`devstack apply\` (or \`devstack up\`) first.`,
				);
			}
			const upstream = networkToUpstream(sui.network);
			if (upstream === undefined) {
				return failAlreadyReported(
					`devstack fork: manifest's services.sui.network='${sui.network}' is not a fork ` +
						`variant. The fork subcommands only work on \`mainnet-fork\` / \`testnet-fork\` / ` +
						`\`devnet-fork\` stacks.`,
				);
			}
			return Effect.succeed<ForkRuntimeContext>({
				stack,
				rpcUrl: sui.rpc.url,
				upstream,
				...(sui.chainId !== undefined ? { chainId: sui.chainId } : {}),
			});
		}),
		Effect.catchTags({
			ManifestDiscoveryError: (cause) => failAlreadyReported(cause.message),
			ManifestShapeError: (cause) => failAlreadyReported(cause.message),
		}),
	);

/** Build a `SuiGrpcClient` against the running fork's RPC URL. The
 *  client's `forkingService` carries the admin RPCs we wire each
 *  subcommand to. */
export const makeForkClient = (ctx: ForkRuntimeContext): SuiGrpcClient =>
	new SuiGrpcClient({ baseUrl: ctx.rpcUrl, network: ctx.upstream });

/** Resolve `--stack` + the fork runtime context in one yield. Every
 *  subcommand that needs the fork's gRPC URL opens with this. */
export const resolveStackAndForkCtx = (stack: Option.Option<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const resolved = yield* resolveStack(fs, path, stack);
		const ctx = yield* resolveForkRuntimeCtx(resolved);
		return ctx;
	});

/** Run a `ForkingService` admin RPC, formatting any rejection as a
 *  `<label> failed — <cause>` message and re-raising as
 *  `AlreadyReportedError`. Every `fork <sub>` command body that talks to
 *  the fork's gRPC admin surface uses this — the alternative is the
 *  five-line `Effect.tryPromise → Effect.catch → failAlreadyReported`
 *  chain repeated at every call site. */
export const wrapForkRpc = <T>(
	label: string,
	fn: () => Promise<T>,
): Effect.Effect<T, AlreadyReportedError> =>
	Effect.tryPromise({
		try: fn,
		catch: (cause) => new Error(`${label} failed — ${String(cause)}`),
	}).pipe(
		Effect.catch((cause) =>
			Effect.gen(function* () {
				yield* failAlreadyReported(cause.message);
				return undefined as never;
			}),
		),
	);
