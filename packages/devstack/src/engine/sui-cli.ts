// Effect-flavored thin wrapper around the `sui` CLI for Move package
// publishing.
//
// Ported from `packages/devstack/src/helpers/publish-via-cli.ts` (v3) and
// adapted to Effect v4:
//
//   - Subprocess work goes through `effect/unstable/process`'s
//     `ChildProcessSpawner` (Node binding provided upstream by
//     `NodeChildProcessSpawner`).
//   - All failures funnel through a single tagged `SuiCliError`.
//
// The CLI flow:
//
//   1. Derive the Sui address from `signerHex` (Ed25519) and run
//      `sui client switch --address <addr>` so the publish tx is signed
//      by the intended keypair. The caller is responsible for making
//      sure the secret is already present in the sui-cli keystore.
//   2. `sui client publish --skip-fetch-latest-git-deps --json …` runs
//      the build + publish in one shot and writes a
//      `SuiTransactionBlockResponse` to stdout.
//   3. Parse, extract the package id from the `published` object change,
//      and the upgrade-cap id from the `created` change whose objectType
//      ends with `0x2::package::UpgradeCap`.
//
// `buildMove` is a thin sibling used by tests / dry-runs that only need
// the compiled bytecode (no publish tx).

import * as os from 'node:os';
import * as path from 'node:path';
import { Context, Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { inheritedHostEnv } from './safe-env.js';
import { stringifyCause } from './stringify-cause.js';
import { SuiBuildContainer } from './sui-build-container.js';

// Optional sui-tools image reference. When `suiLocalnet` builds its
// vendored `sui-image/` it provides the resulting tag here so `buildMove`
// can run `sui move build` INSIDE that image (matching the localnet's
// exact sui version) instead of on the host. The host's `sui` CLI may be
// newer than the pinned localnet release and reject flags the older
// in-image sui requires (e.g. `--json` was renamed to `--json-errors`
// post-`devnet-v1.71.0`), so the host-vs-localnet skew breaks publish on
// any dev machine that's followed sui's release cadence.
//
// Default `undefined` means "no image available — fall back to host
// `sui`". `suiTestnet` / `suiMainnet` / `suiCustom` leave the default in
// place; only `suiLocalnet` populates it. The reference is consumed by
// `buildMove` only.
export const SuiBuildImage = Context.Reference<{ readonly tag: string } | undefined>(
	'@devstack/SuiBuildImage',
	{ defaultValue: () => undefined },
);

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class SuiCliError extends Schema.TaggedErrorClass<SuiCliError>()('SuiCliError', {
	op: Schema.String,
	message: Schema.String,
	// Optional captured streams + exit code from the sui CLI invocation
	// that produced this failure. pretty-error.ts surfaces these when
	// present so build / publish failures are debuggable without
	// re-running.
	stderr: Schema.optional(Schema.String),
	stdout: Schema.optional(Schema.String),
	exitCode: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect),
}) {}

const suiCliError =
	(op: string) =>
	(cause: unknown): SuiCliError => {
		const raw = stringifyCause(cause);
		// ENOENT on spawn means the `sui` binary isn't reachable on the
		// child's PATH. Surface a setup-actionable message rather than the
		// opaque `NotFound: ChildProcess.spawn` Node error. Mismatched
		// versions between a host-installed `sui` and the localnet
		// container's binary can also produce subtle build/publish errors —
		// flag that too so the user knows where to look.
		const isENOENT = raw.includes('ENOENT') || raw.includes('NotFound');
		const friendly = isENOENT
			? `sui CLI not found on PATH. Install from https://github.com/MystenLabs/sui/releases or via \`cargo install --locked --git https://github.com/MystenLabs/sui.git sui\`. (Original: ${raw})`
			: raw;
		return new SuiCliError({ op, message: friendly, cause });
	};

// -----------------------------------------------------------------------------
// buildMove
// -----------------------------------------------------------------------------

export interface BuildMoveOptions {
	readonly path: string;
	readonly rpcUrl: string;
	readonly faucetUrl?: string;
}

export interface BuildMoveResult {
	readonly modules: ReadonlyArray<string>;
	readonly dependencies: ReadonlyArray<string>;
}

interface BuildMoveJson {
	readonly modules: Array<string>;
	readonly dependencies: Array<string>;
}

export const buildMove = (
	opts: BuildMoveOptions,
): Effect.Effect<
	BuildMoveResult,
	SuiCliError,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	// Context.Reference with a defaultValue keeps `SuiBuildImage` out of the R
	// channel — callers that haven't provided it transparently get the `undefined`
	// default (host-CLI mode).
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const image = yield* SuiBuildImage;
		// Prefer the long-lived per-stack build container when present:
		// `docker exec` instead of `docker run --rm` per build cuts
		// per-publish overhead from ~700-1000ms to ~50-100ms. Provided
		// automatically by `suiLocalnet` alongside `SuiBuildImage`;
		// `Effect.serviceOption` keeps the dependency optional so
		// stand-alone callers and live-net configs work unchanged.
		const containerOpt = yield* Effect.serviceOption(SuiBuildContainer);
		const containerReachable =
			containerOpt._tag === 'Some' && containerOpt.value.canExec(opts.path);
		yield* Effect.annotateCurrentSpan({
			'sui.op': 'build',
			'sui.path': opts.path,
			'sui.build.mode': image === undefined ? 'host' : containerReachable ? 'exec' : 'container',
			...(image !== undefined ? { 'sui.build.image': image.tag } : {}),
		});

		// Strip `[pinned.<env>.*]` sections from upstream Move.locks
		// before invoking sui-cli. Upstream Move.locks frequently pin to
		// a specific deploy environment (e.g. `use_environment =
		// "testnet"`), which would cause the build to embed that env's
		// framework package ids — the resulting modules then fail to
		// publish on localnet because those testnet ids aren't on chain.
		// For container builds the scrub now happens inline inside the
		// container shell (see `containerBuildCmd`) so we never mutate
		// the cached source dir on the host — multi-stack supervisors
		// would otherwise trample each other's Move.lock during
		// concurrent boots. Host-cli mode still needs the host scrub.
		if (image === undefined) {
			yield* stripPinnedSectionsFromMoveLock(fs, opts.path).pipe(Effect.ignore);
		}

		// Build inside the localnet's exact sui version when one is
		// available, host-installed sui otherwise. The host fallback is
		// fragile post-devnet-v1.71.0 because newer sui's renamed `--json`
		// to `--json-errors`; the in-container build sidesteps the skew
		// entirely. Three paths:
		//   1. exec — long-lived per-stack container, `docker exec` (fastest)
		//   2. container — fresh `docker run --rm` (Stage 1 fallback)
		//   3. host — host-installed `sui` CLI (no image available)
		const captured =
			containerReachable && containerOpt._tag === 'Some'
				? yield* containerOpt.value.runBuild(opts.path)
				: yield* runWithCapture(
						spawner,
						image !== undefined ? containerBuildCmd(image.tag, opts.path) : hostBuildCmd(opts),
						'sui move build',
					);

		// Non-zero exit ALWAYS fails before the JSON parse — a build that
		// errored out gives us its stderr verbatim instead of the opaque
		// parse-of-empty-string failure. `extractTrailingJson` would
		// otherwise return `''` on empty stdout and the parser would crash
		// without ever surfacing the real error.
		if (captured.exitCode !== 0) {
			// Dump full stderr/stdout to the engine log stream so the user
			// can see the actual build output without depending on the
			// truncated row detail.
			if (captured.stderr.trim().length > 0) {
				yield* Effect.logError(`sui move build stderr:\n${captured.stderr}`);
			}
			if (captured.stdout.trim().length > 0) {
				yield* Effect.logError(`sui move build stdout:\n${captured.stdout}`);
			}
			return yield* Effect.fail(
				new SuiCliError({
					op: 'sui move build',
					message: formatCliFailure('sui move build', captured),
					stdout: captured.stdout,
					stderr: captured.stderr,
					exitCode: captured.exitCode,
				}),
			);
		}

		// Surface the FULL stdout when the parse fails. Without this the
		// user only sees `Unexpected end of JSON input` and has no way to
		// know what sui actually printed.
		const trailing = extractTrailingJson(captured.stdout);
		const built = yield* parseJson<BuildMoveJson>(trailing, 'sui move build').pipe(
			Effect.mapError(
				(err) =>
					new SuiCliError({
						op: err.op,
						message: err.message,
						stdout: captured.stdout,
						stderr: captured.stderr,
						exitCode: captured.exitCode,
						cause: err.cause,
					}),
			),
		);
		return { modules: built.modules, dependencies: built.dependencies };
	}).pipe(Effect.withSpan('SuiCli.buildMove'));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Compose the argv for an in-container `sui move build`. The vendored
// sui-image's default entrypoint runs `sui genesis` first (sets up a
// localnet config) before exec'ing `sui "$@"`. For a one-shot move
// build we don't need genesis — override the entrypoint to call `sui`
// directly so stderr contains only build output, not genesis init logs.
//
// Bind-mount strategy (intentional revert from the tar-pipe approach
// that was here briefly):
//   - The package's PARENT directory is bind-mounted at `/workspace` so
//     sibling `{ local = "../token" }` deps still resolve. Build target
//     remains `--path /workspace/<package-name>`.
//   - `${HOME}/.move` is bind-mounted at `/root/.move` so sui-cli's
//     content-addressed git-deps cache (`~/.move/git/<repo>@<sha>/…`)
//     persists across builds. Without this, every fresh `--rm` container
//     re-fetches the edition-2024 auto-deps (Sui, MoveStdlib, Bridge,
//     DeepBook, SuiSystem) from GitHub — the dominant per-publish cost
//     a v4 user notices vs v3. The cache is SHA-keyed and append-only,
//     so concurrent readers/writers across containers are safe.
//
// Trade-offs:
//   - `build/` outputs leak back to the host's source dir (same as v3
//     host-CLI mode). Within an app, two stacks (e.g.
//     `DEVSTACK_STACK=main` and `DEVSTACK_STACK=test`) building the
//     SAME source path concurrently can race on `build/`. The
//     state-store lock prevents two supervisors per `(stack, network)`
//     tuple, but does not synchronize across stacks. Accepted: the
//     primary use case is one stack at a time per app.
//   - Across apps, source paths live under each app's own dir (or its
//     `.devstack/` cache), so no app-to-app mount sharing.
//   - The in-container `Move.lock` scrub mutates host Move.lock files
//     under the source tree — same effect as host-mode
//     `stripPinnedSectionsFromMoveLock`. Idempotent on subsequent runs.
const containerBuildCmd = (imageTag: string, hostPath: string): ChildProcess.Command => {
	const parent = path.dirname(hostPath);
	const pkgName = path.basename(hostPath);
	// Inside-container Move.lock scrub: `[pinned.<env>.<pkg>]` sections
	// in upstream Move.locks (deepbook's `token` dep, walrus, etc.) pin
	// the build to testnet/mainnet package ids that don't exist on a
	// fresh localnet. Awk drives a stateful skip flag: enter skip on a
	// `[pinned.*]` header, exit on the next non-pinned `[` header.
	// (A sed `addr1,addr2` range would mis-handle consecutive
	// `[pinned.A]`/`[pinned.B]` blocks — the second header is the
	// first range's terminator, so the second block's body leaks
	// through. v4 Move.locks from deepbook ship 4 consecutive pinned
	// blocks, which produced `duplicate key 'source' in table 'move'`
	// TOML errors when their bodies were appended to the preceding
	// `[move]` table.) Idempotent on already-scrubbed locks.
	const stageAwk =
		`printf '%s\\n%s\\n%s\\n' '/^\\[pinned\\./ { skip=1; next }' ` +
		`'/^\\[/ && !/^\\[pinned\\./ { skip=0 }' '!skip { print }' > /tmp/scrub-move-lock.awk`;
	// HIGH-R5: same hardening as the docker-exec path in
	// sui-build-container.ts. `-type f` rejects symlinks so a
	// malicious `Move.lock -> /etc/passwd` symlink in the source tree
	// doesn't get scrubbed; `gawk -i inplace` edits the file in place
	// instead of going through `> $1.new && mv $1.new $1`. The
	// pre-fix shell pattern, when run as root inside the container
	// against bind-mounted source, would have followed any symlink
	// target on the host filesystem.
	//
	// Explicit `gawk` (not `awk`) because Ubuntu's default `awk` is
	// mawk, which doesn't support the `-i inplace` flag — the
	// `sui-image/Dockerfile` adds gawk via apt for this reason. A real-
	// Docker round-trip test (`engine/snapshot.docker.test.ts`) caught
	// this; the publishMove state-store cache hit path masked it on
	// every warm-start dev run.
	//
	// /root/.move/git holds sui-cli's content-addressed dep cache.
	// Upstream Move.lock files inside it pin testnet/mainnet env
	// addresses; on localnet that crashes the build with `Active
	// environment 'localnet' does not correspond to any of
	// environments defined for the package`. The host scrub
	// (`stripPinnedSectionsFromMoveLock`) used to handle this — but
	// it's bypassed entirely on container builds (line 150-152) since
	// the bind-mounted ~/.move is the source of truth. The
	// `[ -d /root/.move/git ]` guard avoids a `find` error on a
	// first-ever build before any deps have been cached.
	const scrub =
		`find /workspace -type f -name Move.lock -not -path '*/node_modules/*' -not -path '*/.git/*' ` +
		`-exec gawk -i inplace -f /tmp/scrub-move-lock.awk {} ';' ; ` +
		`[ -d /root/.move/git ] && find /root/.move/git -type f -name Move.lock -not -path '*/.git/*' ` +
		`-exec gawk -i inplace -f /tmp/scrub-move-lock.awk {} ';' || true`;
	// `pkgName` lands inside the in-container `sh -c` script as part of
	// `--path /workspace/<name>`. Shell-quote so a malicious package
	// name (e.g. one containing `$(…)` or `;`) can't escape the script
	// and run commands inside the container. The bind-mounts grant the
	// container write access to the user's source dir and `~/.move`,
	// so unquoted interpolation here would be a real foot-gun even
	// though the container itself is ephemeral.
	// `-e testnet` — sui-cli ≥ 1.71 requires the build env to match one
	// of the package's resolved `[pinned.<env>.*]` sections. Without
	// `-e`, the CLI's active env defaults to `localnet`, but the Sui
	// framework dep only ships pinned metadata for testnet + mainnet,
	// so cold-cache builds fail with "Active environment 'localnet'
	// does not correspond to any of environments defined for the
	// package". testnet is a safe choice: the build's output bytecode
	// uses symbolic addresses that are resolved at publish time, so
	// pinning to testnet vs mainnet vs localnet produces identical
	// bytecode for our purposes. The actual publish tx (driven later
	// by `publishMove`) lands on whatever network devstack is wired
	// to. This was caught by `engine/snapshot.docker.test.ts`'s
	// always-cold-cache round-trip; the publishMove state-store
	// cache hit masked it on every warm-start dev run.
	const innerScript = [
		'set -e',
		stageAwk,
		scrub,
		// `--no-tree-shaking` keeps the build offline. Without it, sui-cli
		// tries to confirm each dependency's published digest by RPC to
		// the configured env's fullnode (testnet here) — the build
		// container has no network for that lookup, so the build fails
		// with `Failed to fetch package MoveStdlib: tcp connect error`.
		// We don't need tree-shaking for our use case: the publish tx
		// downstream runs against devstack's localnet RPC and submits
		// the full bytecode regardless.
		`exec sui move build --path /workspace/${shellQuote(pkgName)} -e testnet --no-tree-shaking --dump-bytecode-as-base64 --with-unpublished-dependencies`,
	].join('; ');
	const moveHome = path.join(os.homedir(), '.move');
	const dockerArgs = [
		'run',
		'--rm',
		'-i',
		'-v',
		`${parent}:/workspace`,
		'-v',
		`${moveHome}:/root/.move`,
		'--entrypoint',
		'sh',
		imageTag,
		'-c',
		innerScript,
	];
	return ChildProcess.make('docker', dockerArgs);
};

// POSIX single-quote escape for arbitrary string values embedded in a
// shell command. Wraps in `'…'` and escapes embedded single quotes via
// the standard `'\''` trick. Used inside `containerBuildCmd` to quote
// the package name in the in-container `sh -c` script — the bind-mount
// gives the container write access to the host source dir and
// `~/.move`, so unquoted interpolation would be a real foot-gun if a
// caller passed a path with shell metachars.
export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

// Compose the argv for a host-`sui` `move build`. Same flags as the
// container path, but spawned directly with the host-inherited env so
// `sui` can read its own keystore + config dir. Kept as a fallback for
// suiTestnet / suiMainnet / suiCustom where there's no localnet image
// to dispatch into.
const hostBuildCmd = (opts: BuildMoveOptions): ChildProcess.Command =>
	ChildProcess.make(
		'sui',
		[
			'move',
			'build',
			'--path',
			opts.path,
			// `-e testnet --no-tree-shaking` mirrors the in-container
			// path. See the comment in `containerBuildCmd` for the
			// rationale on each flag.
			'-e',
			'testnet',
			'--no-tree-shaking',
			'--dump-bytecode-as-base64',
			'--with-unpublished-dependencies',
		],
		{ env: cliEnv(opts) },
	);

// Build the env-var map for sui-cli invocations. `SUI_FULLNODE_URL`
// points the CLI at our localnet RPC; `SUI_FAUCET_URL` is added when
// the caller provided one (faucet calls happen elsewhere; we still
// thread it so any sui-cli subcommand that reads it picks up the right
// URL).
const cliEnv = (opts: { rpcUrl: string; faucetUrl?: string }): Record<string, string> => {
	// Merge the safe inherited host env (PATH, HOME, etc.) so the spawned
	// `sui` binary is actually resolvable. Without this the child gets ONLY
	// the two SUI_* vars below — PATH is empty → ENOENT even when sui is
	// installed and on the user's interactive shell PATH.
	const env: Record<string, string> = { ...inheritedHostEnv(), SUI_FULLNODE_URL: opts.rpcUrl };
	if (opts.faucetUrl !== undefined) env.SUI_FAUCET_URL = opts.faucetUrl;
	return env;
};

// `sui move build --json` writes pure JSON to stdout, but other
// subcommands occasionally emit progress lines first. Find the last
// `{`-terminated chunk and parse that — same trick the v3 port uses.
// Exported indirectly via `buildMove`; kept module-private otherwise.
const extractTrailingJson = (text: string): string => {
	const trimmed = text.trim();
	if (trimmed.startsWith('{')) return trimmed;
	const idx = trimmed.lastIndexOf('{');
	if (idx === -1) return trimmed;
	return trimmed.slice(idx);
};

// Captured output of one `sui` invocation. Mirrors `DockerExecResult` in
// docker.ts — separate types because shared infra would couple two
// otherwise-independent modules. Exported so the long-lived build
// container (`sui-build-container.ts`) returns the same shape.
export interface SuiCliCapture {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

// Spawn `cmd`, drain stdout + stderr + exit code concurrently. The
// spawner's `.string(...)` helper only captures stdout, which loses the
// reason a failing `sui move build` failed (compile errors, missing
// deps, host-vs-localnet version skew, etc. land on stderr). Mapped
// errors carry the same `op` prefix that downstream callers stamp.
export type Spawner = ReturnType<typeof ChildProcessSpawner.make>;

export const runWithCapture = (
	spawner: Spawner,
	cmd: ChildProcess.Command,
	op: string,
): Effect.Effect<SuiCliCapture, SuiCliError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(cmd).pipe(Effect.mapError(suiCliError(op)));
			const decode = <E>(stream: Stream.Stream<Uint8Array, E>) =>
				Stream.mkString(Stream.decodeText(stream));
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					decode(handle.stdout).pipe(Effect.mapError(suiCliError(op))),
					decode(handle.stderr).pipe(Effect.mapError(suiCliError(op))),
					handle.exitCode.pipe(Effect.mapError(suiCliError(op))),
				],
				{ concurrency: 'unbounded' },
			);
			return { exitCode: exitCode as number, stdout, stderr };
		}),
	);

// Build the user-facing failure message for a non-zero CLI exit.
// Prefers stderr (where sui prints errors) and falls back to stdout for
// the odd subcommand that swaps the two. Truncated to keep TUI rows
// readable; the full output is still available via the OTLP span.
const formatCliFailure = (op: string, captured: SuiCliCapture): string => {
	const stderr = captured.stderr.trim();
	const stdout = captured.stdout.trim();
	const detail = stderr.length > 0 ? stderr : stdout;
	return `${op} exited ${captured.exitCode}: ${truncateForError(detail)}`;
};

const MAX_ERROR_DETAIL = 600;

const truncateForError = (text: string): string => {
	const collapsed = text.replace(/\r/g, '').trim();
	if (collapsed.length === 0) return '(empty)';
	if (collapsed.length <= MAX_ERROR_DETAIL) return collapsed;
	return `${collapsed.slice(0, MAX_ERROR_DETAIL - 1)}…`;
};

// Parse JSON inside an Effect so decoding failures map to `SuiCliError`.
const parseJson = <T>(text: string, op: string): Effect.Effect<T, SuiCliError> =>
	Effect.try({
		try: () => JSON.parse(text) as T,
		catch: suiCliError(`${op} (json parse)`),
	});

// -----------------------------------------------------------------------------
// scrubCachedMoveLocks
// -----------------------------------------------------------------------------

// Walk `~/.move/git/` (sui-cli's content-addressed dep cache) and strip
// `[env]` / `[env.<name>]` sections from every `Move.lock` whose
// entries declare a published-id. Reason: sui-cli's legacy-manifest
// resolver reads those entries and treats the dep as
// already-published-on-chain. For deepbook's `token` dep that pulls the
// testnet id and embeds it in the publish tx's `dependencies` array —
// which then fails on a fresh localnet where that package id doesn't
// exist. With the entries stripped, `--with-unpublished-dependencies`
// correctly inlines the dep's bytecode.
//
// Ported from v3 `packages/devstack/src/helpers/publish-via-cli.ts`.
// The `packagePath` argument is retained for API symmetry with the
// caller (and a future per-package narrowing); the cache is keyed by
// `<repo>@<rev>` so scrubbing it globally is safe and idempotent.
//
// Best-effort: missing cache root, unreadable lockfiles, etc. all
// surface as a silent no-op. Any successful scrubs are recorded as a
// span attribute.
export const scrubCachedMoveLocks = (
	_packagePath: string,
): Effect.Effect<void, SuiCliError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const root = path.join(os.homedir(), '.move', 'git');

		const rootExists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
		if (!rootExists) {
			yield* Effect.annotateCurrentSpan({ 'sui.scrub.root.missing': true });
			return;
		}

		// `readDirectory({ recursive: true })` returns paths relative to
		// `root`. Filter to `Move.lock` files and ignore anything inside
		// a `.git` directory (we never need to touch git internals).
		const entries = yield* fs
			.readDirectory(root, { recursive: true })
			.pipe(Effect.mapError(suiCliError('scrubCachedMoveLocks readDirectory')));

		const lockPaths = entries
			.filter((rel) => rel.endsWith(`${path.sep}Move.lock`) || rel === 'Move.lock')
			.filter((rel) => !rel.split(path.sep).includes('.git'))
			.map((rel) => path.join(root, rel));

		let scrubbed = 0;
		for (const lockPath of lockPaths) {
			const didScrub = yield* scrubMoveLock(fs, lockPath);
			if (didScrub) scrubbed++;
		}

		yield* Effect.annotateCurrentSpan({
			'sui.scrub.candidates': lockPaths.length,
			'sui.scrub.modified': scrubbed,
		});
	}).pipe(Effect.withSpan('SuiCli.scrubCachedMoveLocks'));

// Read a single Move.lock, strip env / pinned-env sections, write back
// if changed. Returns `true` if the file was modified. Silently skips
// on read / parse failure — the file may be partial mid-fetch or owned
// by another user. Uses `stripPinnedSections` so both legacy `[env.*]`
// sections AND Move.lock v4 `[pinned.<env>.<pkg>]` sections get
// removed; either flavor can carry the published-id pin that bakes a
// testnet/mainnet address into a `move build`.
const scrubMoveLock = (
	fs: FileSystem.FileSystem,
	lockPath: string,
): Effect.Effect<boolean, never> =>
	Effect.gen(function* () {
		const readResult = yield* fs.readFileString(lockPath, 'utf8').pipe(
			Effect.map((s) => ({ ok: true as const, contents: s })),
			Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
		);
		if (!readResult.ok) {
			// Surface the cause as a warning rather than silently
			// no-op'ing. Host-mode publish would otherwise embed stale
			// pinned IDs from an unreadable lockfile and fail on chain
			// with no breadcrumb pointing here.
			yield* Effect.logWarning(
				`scrubMoveLock: could not read ${lockPath} (${(readResult.cause as { message?: string })?.message ?? 'unknown'}); pinned-env stripping skipped — host-mode publish may embed stale ids`,
			);
			return false;
		}
		const cleaned = stripPinnedSections(readResult.contents);
		if (cleaned === readResult.contents) return false;

		const writeOk = yield* fs.writeFileString(lockPath, cleaned).pipe(
			Effect.map(() => true),
			Effect.catch((cause) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(
						`scrubMoveLock: stripped pinned-env sections in memory but could not write ${lockPath} (${(cause as { message?: string })?.message ?? 'unknown'})`,
					);
					return false;
				}),
			),
		);
		return writeOk;
	});

// Strip Move.lock v4 `[pinned.<env>.<pkg>]` sections from any Move.lock
// reachable from `packagePath`. These sections lock the build to a
// specific environment's package addresses; on localnet they cause the
// build to embed testnet ids and the publish then fails ("Dependent
// package not found on-chain"). Idempotent — re-stripping a scrubbed
// lockfile is a no-op. Walks the package's source tree AND any
// vendored deps under sibling `.devstack/imports/` directories the
// caller may have pre-fetched, so transitive `pinned.<env>.<dep>`
// entries inside deepbook/token/etc. lockfiles also get scrubbed.
const stripPinnedSectionsFromMoveLock = (
	fs: FileSystem.FileSystem,
	packagePath: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		// Scrub the package's own Move.lock.
		yield* scrubLockFileIfPresent(fs, path.join(packagePath, 'Move.lock'));
		// Scrub `~/.move/git/<rev>/<subdir>/Move.lock` — sui-cli's
		// cache of git-fetched Move deps. v3's `scrubCachedMoveLocks`
		// targeted this path explicitly because deepbook's `token`
		// dep pins testnet's published id (`0x36dbef…`) into its
		// lockfile, which then gets embedded into the deepbook
		// bytecode on publish and fails on localnet.
		yield* scrubLockFilesUnder(fs, path.join(os.homedir(), '.move', 'git')).pipe(Effect.ignore);
		// Walk for sibling vendored-imports lockfiles. Stop at the first
		// `.devstack/imports` we find on the way up so we cover the
		// example's full Move tree without recursing into the workspace
		// root (which can contain unrelated lockfiles).
		let dir = packagePath;
		for (let i = 0; i < 6; i++) {
			const importsDir = path.join(dir, '.devstack', 'imports');
			const importsExists = yield* fs.exists(importsDir).pipe(Effect.orElseSucceed(() => false));
			if (importsExists) {
				yield* scrubLockFilesUnder(fs, importsDir).pipe(Effect.ignore);
				return;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	});

// Best-effort recursive scrub. Walks `dir` and scrubs every `Move.lock`
// it finds, skipping `node_modules` / `.git` for obvious reasons.
const scrubLockFilesUnder = (
	fs: FileSystem.FileSystem,
	dir: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const entries = yield* fs
			.readDirectory(dir)
			.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
		for (const name of entries) {
			if (name === 'node_modules' || name === '.git') continue;
			const full = path.join(dir, name);
			const info = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined));
			if (info === undefined) continue;
			if (info.type === 'Directory') {
				yield* scrubLockFilesUnder(fs, full);
			} else if (name === 'Move.lock') {
				yield* scrubLockFileIfPresent(fs, full);
			}
		}
	});

const scrubLockFileIfPresent = (
	fs: FileSystem.FileSystem,
	lockPath: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(lockPath).pipe(Effect.orElseSucceed(() => false));
		if (!exists) return;
		const contents = yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => undefined));
		if (contents === undefined) return;
		const scrubbed = stripPinnedSections(contents);
		if (scrubbed === contents) return;
		yield* fs.writeFileString(lockPath, scrubbed).pipe(Effect.ignore);
	});

// Exported for unit tests; production callers go through
// `scrubLockFileIfPresent` / `scrubMoveLock` which read + write the
// file around this pure transform.
export const stripPinnedSections = (source: string): string => {
	const lines = source.split('\n');
	const out: Array<string> = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith('[')) {
			const header = trimmed.replace(/\s+/g, '');
			// Skip both v4-style `[pinned.<env>.<pkg>]` sections AND the
			// legacy `[env]` / `[env.<name>]` sections v3's
			// `scrubCachedMoveLocks` targeted. Either one can carry
			// `published-at`/`original-id` entries that pin a transitive
			// dep to a specific net's id, which then ends up baked into
			// the publish's bytecode.
			if (header.startsWith('[pinned.') || header === '[env]' || header.startsWith('[env.')) {
				skipping = true;
				continue;
			}
			skipping = false;
		}
		if (!skipping) out.push(line);
	}
	return out.join('\n');
};
