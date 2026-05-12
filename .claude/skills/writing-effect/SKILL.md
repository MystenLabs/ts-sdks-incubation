---
name: writing-effect
description: Use when writing or reviewing Effect-TS code (any file importing from "effect" or "@effect/*"). Covers Effect.gen, services via Effect.Service, Schema, error handling with catchTag/catchTags, observability via withSpan/annotateCurrentSpan, and testing with @effect/vitest's it.effect. Targets Effect v4 beta. Defers authoritative answers to the effect_docs_search MCP tool (registered in .mcp.json).
---

# Writing Effect

Effect-TS coding guide for this monorepo. **Authoritative source**: when you need detail beyond what's here, call `effect_docs_search` via the `effect-docs` MCP server (registered in `.mcp.json` at the repo root). Also useful: [`https://effect.website/llms-full.txt`](https://effect.website/llms-full.txt).

## Version

This monorepo targets **Effect v4 beta** (pinned in `pnpm-workspace.yaml` catalog). v4 consolidates many former sub-packages into core `effect`:

- `Schema` lives in `effect` (not `@effect/schema`). Import: `import { Schema } from 'effect'`.
- `Stream`, `Sink`, `Channel`, `FileSystem`, `Path`, `Terminal`, `Stdio`, `Schedule`, `Pool`, `Semaphore`, `Cron`, `DateTime`, `Match` — all in core `effect`.
- **CLI**: `effect/unstable/cli` (unstable).
- **Child process**: `effect/unstable/process` + Node binding via `@effect/platform-node`'s `NodeChildProcessSpawner` (stable).
- **HTTP / HttpApi / RPC**: `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/rpc`.
- **Vitest**: `@effect/vitest`. The v4 API differs from v3: use `it.effect` (it already includes a `Scope` — no separate `it.scoped`). The package re-exports all of vitest, so import `describe`, `expect`, `it` from `@effect/vitest`. No `assert` export — use `expect`. Never use `Effect.runSync` inside `it`.

When this guide conflicts with what the MCP returns for v4, trust the MCP and update this skill.

## Repo conventions

- Tabs for indentation. Single quotes. Trailing commas. Width 100. Prettier handles all of it.
- Lint via root `pnpm lint` (oxlint + prettier). No per-package overrides.
- Prototype repo — **break APIs directly**, no shims or deprecation cycle. See repo-root `AGENTS.md`.
- Capture friction in `packages/<pkg>/notes/friction.md`.

## Core idioms

### Use `Effect.gen` for async/await-style flow

```ts
import { Effect, Random } from 'effect';

Effect.gen(function* () {
	yield* Effect.sleep('1 second');
	const bool = yield* Random.nextBoolean;
	if (bool) {
		// Always `return yield*` with Effect.fail so TS narrows conditional types
		return yield* Effect.fail('Random boolean was true');
	}
	return 'Returned value';
}).pipe(Effect.withSpan('tracing span'));
```

### Use `Effect.fn` for named Effect-returning functions

```ts
import { Effect, Random } from 'effect';

const myFn = Effect.fn('myFn')(
	function* (x: number, y: number) {
		const bool = yield* Random.nextBoolean;
		if (bool) return yield* Effect.fail('Random boolean was true');
		return x + y;
	},
	Effect.annotateLogs({ some: 'annotation' }),
	(effect, x, y) => Effect.annotateLogs(effect, { x, y }),
);
```

### Avoid `try`/`catch` — use `Effect.try` / `Effect.tryPromise`

```ts
import { Effect, Schema } from 'effect';

class JsonError extends Schema.TaggedError<JsonError>('JsonError')({
	cause: Schema.Defect,
}) {}

Effect.gen(function* () {
	const parsed = yield* Effect.try({
		try: () => JSON.parse('{"invalid": }'),
		catch: (cause) => new JsonError({ cause }),
	});
	const body = yield* Effect.tryPromise({
		try: () => fetch('https://example.com').then((r) => r.json()),
		catch: (cause) => new JsonError({ cause }),
	});
	return { parsed, body };
});
```

### Error handling

- `Effect.catchAll` — all errors
- `Effect.catchAllCause` — including defects
- `Effect.catchTag` / `Effect.catchTags` — specific tagged errors
- `Effect.catchIf` — conditional

```ts
someEffect.pipe(
	Effect.catchTag('ErrorA', (e) => Effect.log('Caught ErrorA', e)),
	Effect.catchTags({
		ErrorA: (e) => Effect.log('A', e),
		ErrorB: (e) => Effect.log('B', e),
	}),
);
```

## Services — the most important pattern

**Most Effect code should be written as services.** They bundle related Effect functions and let Effect's DI wire them up.

```ts
import { Effect, Schema } from 'effect';

export class Database extends Effect.Service<Database>()('Database', {
	dependencies: [],
	// ESSENTIAL: always use `scoped:` — gives the service a Scope for finalizers
	scoped: Effect.gen(function* () {
		const query = Effect.fn('Database.query')(function* (sql: string) {
			yield* Effect.annotateCurrentSpan({ sql });
			return { rows: [] };
		});
		return { query } as const;
	}),
}) {}

export class UserServiceError extends Schema.TaggedError<UserServiceError>('UserServiceError')({
	cause: Schema.optional(Schema.Defect),
}) {}

export class UserService extends Effect.Service<UserService>()('UserService', {
	dependencies: [Database.Default], // Database.Default is the auto-generated Layer
	scoped: Effect.gen(function* () {
		const database = yield* Database;
		const getAll = database.query('SELECT * FROM users').pipe(
			Effect.map((r) => r.rows),
			Effect.mapError((cause) => new UserServiceError({ cause })),
		);
		return { getAll } as const;
	}),
}) {}
```

**Essential**: there should be exactly one `Effect.provide` in an application, at the top level. Compose Layers via the `Layer` module instead.

## Domain entities via Schema

```ts
import { Schema } from 'effect';

export const UserId = Schema.String.pipe(Schema.brand('UserId'));
export type UserId = (typeof UserId).Type;

export class User extends Schema.Class<User>('User')({
	id: UserId,
	name: Schema.String,
	email: Schema.String,
	createdAt: Schema.DateTimeUtc, // prefer DateTimeUtc
}) {}

export class UserError extends Schema.TaggedError<UserError>('UserError')({
	cause: Schema.optional(Schema.Defect),
	message: Schema.String,
}) {}
```

## Observability

- `Effect.withSpan('name')` — attach a span
- `Effect.fn('name')(fn)` — function with span
- `Effect.annotateCurrentSpan({ k: v })` — add attributes
- `Effect.log` / `logInfo` / `logWarning` / `logError` / `logFatal` / `logDebug` / `logTrace`

## Testing with `@effect/vitest`

In v4 the primary runner is `it.effect` — it implicitly provides a `Scope`. `it.live` runs against the live clock; `it.layer(layer)('group', (it) => {...})` shares a Layer across nested tests.

```ts
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

describe('My Effect tests', () => {
	it.effect('runs an Effect', () =>
		Effect.gen(function* () {
			const result = yield* Effect.succeed('Hello');
			expect(result).toBe('Hello');
		}),
	);

	it.effect('handles errors with Effect.flip', () =>
		Effect.gen(function* () {
			const error = yield* Effect.fail('boom').pipe(Effect.flip);
			expect(error).toBe('boom');
		}),
	);
});
```

- `@effect/vitest` re-exports all of vitest, so `describe`, `expect`, `it`, etc. come from it. There is no `assert` export — use `expect`.
- Never use `Effect.runSync` inside `it`; use `it.effect`.

## When in doubt

Call `effect_docs_search` via the `effect-docs` MCP server. It's the authoritative source for Effect docs and is registered repo-wide in `.mcp.json`.
