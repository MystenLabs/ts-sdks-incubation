// Per-devstack identity — the `<app, stack, network>` triple that gets
// stamped onto every container we launch via `Docker.run`. Two
// downstream consumers care:
//
//   1. `internal/docker.ts` reads this to append
//      `--label devstack.app=<app> --label devstack.stack=<stack>
//       --label devstack.action=<name>` on every container, and to
//      compute the `<app>[-<stack>][-<network>]`-shaped container /
//      compose-project name (see `composeContainerName` /
//      `composeProjectName`).
//   2. `cli/commands/wipe.ts` and `cli/commands/stack.ts down` use the
//      labels to enumerate (`docker ps --filter label=devstack.stack=...`)
//      and kill our containers, instead of the weaker `name=^devstack-`
//      heuristic.
//
// `defineDevstack` provides this via `Layer.succeed(Identity, {...})` —
// `app` is derived from `<cwd>/package.json#name` (scope-stripped) with
// `basename(cwd)` as the fallback, matching v3's `cli/env.ts`
// `resolveAppName` behavior. `stack` echoes `DevstackConfig.stackName`
// (default `'main'`); `network` echoes `DevstackConfig.network`
// (default `'localnet'`). The `network` dimension keeps
// `<app, stack>=<arena, main>` against testnet from colliding on
// docker container/volume/network names with the same pair against
// localnet — without it, switching `network: 'localnet' → 'testnet'`
// would adopt the localnet containers verbatim and dial them
// expecting testnet RPC.

import { Context } from 'effect';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SuiNetwork } from '../services/sui.js';

export interface IdentityShape {
	readonly app: string;
	readonly stack: string;
	readonly network: SuiNetwork;
}

export class Identity extends Context.Service<Identity, IdentityShape>()('@devstack/Identity') {}

// `<app>` and `<stack>` flow into docker container names + labels +
// filesystem paths under `.devstack/stacks/<stack>/`. Allow lowercase
// alphanumeric + `._-`, must start with a letter or digit, max 64 chars.
// Disallowing `..`, `/`, and shell-meaningful characters at the
// boundary stops typos from traversing directories or breaking docker's
// `--label key=value` parser later.
const IDENTITY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const requireValidIdentityName = (kind: 'app' | 'stack', value: string): void => {
	if (!IDENTITY_NAME_RE.test(value)) {
		throw new TypeError(
			`Identity: ${kind} '${value}' is invalid — must match ${IDENTITY_NAME_RE.source}`,
		);
	}
};

/** Validate an `IdentityShape` at the construction boundary. Call from
 *  any compose path that builds an Identity — the supervisor reads
 *  these strings as labels / paths and a malformed value surfaces as
 *  an inscrutable docker or filesystem error far downstream. */
export const validateIdentity = (identity: IdentityShape): void => {
	requireValidIdentityName('app', identity.app);
	requireValidIdentityName('stack', identity.stack);
};

// Derive the app name from `<appDir>/package.json#name` (stripping any
// npm scope like `@foo/`), falling back to `basename(appDir)`. Mirrors
// v3 `packages/devstack/src/cli/env.ts:168-198` but synchronous so it
// can run inside `defineDevstack` without an extra `await`.
export const deriveAppName = (appDir: string = process.cwd()): string => {
	const fromPkg = readPackageName(appDir);
	const candidate = fromPkg ?? basename(appDir);
	// Strip any leading non-alphanumeric (e.g. `_template`) so the value
	// survives docker's `--label` parser and v3's container-name validator.
	return candidate.replace(/^[^a-zA-Z0-9]+/, '') || 'devstack-app';
};

const readPackageName = (appDir: string): string | undefined => {
	let raw: string;
	try {
		raw = readFileSync(join(appDir, 'package.json'), 'utf8');
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const name = (parsed as { name?: unknown }).name;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	return name.includes('/') ? (name.split('/').pop() ?? name) : name;
};
