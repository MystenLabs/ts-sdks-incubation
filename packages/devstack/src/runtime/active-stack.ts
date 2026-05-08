// Active-stack pointer for per-app named environments.
//
// Each app's `<appDir>/.devstack/active` text file holds the name of the
// currently-active stack — the one `devstack up` brings up, the one Vite
// reads manifest/keys from, the one tests target unless overridden.
// Defaults to 'main' when the file is absent.
//
// Resolution order in CLIs is `--stack` flag → `DEVSTACK_STACK` env var
// → pointer file → `'main'`. The runtime never auto-creates the pointer
// on read; only `writeActiveStack` writes it. This keeps `up` purely
// idempotent on a fresh checkout (no stray writes) until the user picks
// a stack via `devstack stack new` / `use`.
//
// `node:fs` / `node:path` load via top-level `await import(...)` so
// the static surface stays browser-safe — see `runtime/hash.ts`'s
// header for the same pattern's rationale.

const [nodeFs, nodePath] = await Promise.all([import('node:fs'), import('node:path')]);

export const DEFAULT_STACK = 'main';

/** Reserved stack used by e2e/integration test runs so `main` is never trampled. */
export const TEST_STACK = 'test';

/** Charset for stack names. Same shape as `cli/stack.ts`'s validator —
 * applied at every resolve boundary so a malformed `.devstack/active`
 * pointer or `DEVSTACK_STACK` env can't smuggle a path-traversal value
 * (`'../foo'`) into `<appDir>/.devstack/stacks/<stack>/`. */
const STACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Refuse to let users create a stack named `'test'` via `devstack stack
 * new test`. The e2e harness (`defineDevstackPlaywrightConfig`,
 * `defineDevstackVitestConfig({ chain: true })`) defaults to this name,
 * applies a setup-action filter to it, and tears it down (`down` or
 * `drop`) when the run finishes. If a user had previously created a
 * regular dev stack called `test`, `pnpm test:e2e` would silently
 * destroy it. The validator below enforces the reservation at the only
 * boundary where a user-typed name reaches a stack-creating code path
 * (CLI `stack new` / `stack use` calls `validateUserStackName`). The
 * harness itself sidesteps this check by writing the active-stack
 * pointer programmatically. */
export function validateUserStackName(name: string): void {
	if (!STACK_NAME_RE.test(name)) {
		throw new Error(
			`stack name '${name}' must match ${STACK_NAME_RE} — lowercase letters, digits, dashes; up to 31 chars; no leading dash`,
		);
	}
	if (name === TEST_STACK) {
		throw new Error(
			`stack name '${TEST_STACK}' is reserved for the e2e test harness. Choose a different name (e.g. \`dev\`, \`feature-foo\`).`,
		);
	}
}

export function activeStackFile(appDir: string): string {
	return nodePath.join(appDir, '.devstack', 'active');
}

export function readActiveStack(appDir: string): string {
	const path = activeStackFile(appDir);
	if (!nodeFs.existsSync(path)) return DEFAULT_STACK;
	const raw = nodeFs.readFileSync(path, 'utf8').trim();
	if (raw.length === 0) return DEFAULT_STACK;
	if (!STACK_NAME_RE.test(raw)) {
		throw new Error(
			`devstack: '.devstack/active' contains invalid stack name '${raw}'. ` +
				`Must match ${STACK_NAME_RE}; rewrite with \`devstack stack use <name>\` ` +
				'or delete the file to fall back to `main`.',
		);
	}
	return raw;
}

export function writeActiveStack(appDir: string, name: string): void {
	const path = activeStackFile(appDir);
	nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
	// Atomic write: stage to `.tmp` then `rename` (POSIX-atomic on the
	// same filesystem). A concurrent reader sees either the prior pointer
	// or the new one — never a half-written file. Matches the manifest
	// writer's pattern.
	const tmp = `${path}.tmp`;
	nodeFs.writeFileSync(tmp, `${name}\n`, 'utf8');
	nodeFs.renameSync(tmp, path);
}

/** Path to a stack's host-side state directory (manifest + keys live here). */
export function stackDir(appDir: string, stack: string): string {
	return nodePath.join(appDir, '.devstack', 'stacks', stack);
}

/** Resolve a stack name from CLI flag → env var → pointer file → default.
 * Validates flag and env values against `STACK_NAME_RE` so a hostile or
 * typo'd value can't reach `<appDir>/.devstack/stacks/<stack>/`. The CLI
 * `stack new/use` paths apply the same validation up front, but resolve
 * is the boundary every code path runs through. */
export function resolveStack(opts: { appDir: string; flag?: string | undefined }): string {
	if (opts.flag !== undefined && opts.flag.length > 0) {
		if (!STACK_NAME_RE.test(opts.flag)) {
			throw new Error(
				`devstack: --stack '${opts.flag}' must match ${STACK_NAME_RE}.`,
			);
		}
		return opts.flag;
	}
	const envVal = process.env.DEVSTACK_STACK;
	if (envVal !== undefined && envVal.length > 0) {
		if (!STACK_NAME_RE.test(envVal)) {
			throw new Error(
				`devstack: DEVSTACK_STACK='${envVal}' must match ${STACK_NAME_RE}.`,
			);
		}
		return envVal;
	}
	return readActiveStack(opts.appDir);
}
