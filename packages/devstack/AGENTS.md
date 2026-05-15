# Writing Effect Guide — devstack

This package targets **Effect v4 beta**.

For package-specific conventions — primitives, interface tags, the
`defineDevstack` / `provideDevstack` split, and the plugin-author tier
— see [`README.md`](./README.md) and
[`PLUGIN-AUTHORING.md`](./PLUGIN-AUTHORING.md). The rest of this file
covers Effect v4 patterns the whole package follows.

**Authoritative source**: the Effect v4 source is vendored at
[`repos/effect-v4/`](../../repos/effect-v4/) (via `git subtree`). When you need to verify an API,
grep `repos/effect-v4/packages/effect/src/` and `repos/effect-v4/packages/platform-node/src/`
directly — docs lag the beta, source doesn't. The vendored repo's own
[`AGENTS.md`](../../repos/effect-v4/AGENTS.md) and [`LLMS.md`](../../repos/effect-v4/LLMS.md) are
worth a skim. The web docs at
[`https://effect.website/llms-full.txt`](https://effect.website/llms-full.txt) are useful too but
may be v3-flavored in places.

Rules for the vendored repo:

- Treat `repos/effect-v4/` as **read-only** reference material. Do not edit files there.
- Do not import from `repos/effect-v4/` in our source. Use the `effect@beta` /
  `@effect/platform-node@beta` npm packages (pinned in the workspace catalog).
- To refresh:
  `git subtree pull --prefix=repos/effect-v4 https://github.com/Effect-TS/effect-smol.git main --squash`.

## Repo conventions

- Read the repo-root [`AGENTS.md`](../../AGENTS.md) first. Highlights: prototype repo, **break APIs
  directly** — no shims, no deprecation cycle. Capture friction in
  [`notes/friction.md`](./notes/friction.md) rather than papering over it.
- Lint and format via root tooling: `pnpm lint` (oxlint + prettier). No per-package overrides.
- Tabs for indentation. Single quotes. Trailing commas. Width 100. Prettier handles all of it —
  don't fight it manually.
- Scope: `@mysten-incubation/*`. This package is workspace-only, marked `private: true`.

## v4-specific notes (read before writing Effect)

- **`Schema` is in core `effect`**, not `@effect/schema`. Import as
  `import { Schema } from 'effect'`. The old `@effect/schema` package does not exist in v4.
- **`Stream`, `Sink`, `Channel`, `FileSystem`, `Path`, `Terminal`, `Stdio`, `Schedule`, `Pool`,
  `Semaphore`, `Cron`, `DateTime`, `Match`** are all in core `effect`.
- **CLI** lives at `effect/unstable/cli`. Unstable in v4 beta — expect minor API drift.
- **Child process** abstractions live at `effect/unstable/process` (`ChildProcess`,
  `ChildProcessSpawner`). The Node binding (`NodeChildProcessSpawner`) is stable in
  `@effect/platform-node`.
- **HTTP / HttpApi / RPC** live in `effect/unstable/http`, `effect/unstable/httpapi`,
  `effect/unstable/rpc`.
- **Vitest integration** uses `@effect/vitest`. The v4 API differs from v3 here: use `it.effect` (it
  already includes a `Scope` — no separate `it.scoped` in v4). The package re-exports everything
  from `vitest`, so import `describe`, `expect`, `it` from `@effect/vitest`. There is no `assert`
  export — use `expect`. Never use `Effect.runSync` inside `it`.
- When the writing-effect guide below conflicts with what the vendored `repos/effect-v4/` source
  shows, **trust the source** and update this file.

## Writing basic Effects

Prefer `Effect.gen` for async/await-style readability:

```ts
import { Effect, Random } from 'effect';

Effect.gen(function* () {
	yield* Effect.sleep('1 second');
	const bool = yield* Random.nextBoolean;
	if (bool) {
		// Always use `return yield*` with Effect.fail so TS narrows conditional types
		return yield* Effect.fail('Random boolean was true');
	}
	return 'Returned value';
}).pipe(Effect.withSpan('tracing span'));
```

## Writing Effect functions

Use `Effect.fn` for named functions — it adds a tracing span and lets you `yield*`:

```ts
import { Effect, Random } from 'effect';

const myEffectFn = Effect.fn('myEffectFn')(
	function* (x: number, y: number) {
		const bool = yield* Random.nextBoolean;
		if (bool) return yield* Effect.fail('Random boolean was true');
		return x + y;
	},
	Effect.annotateLogs({ some: 'annotation' }),
	(effect, x, y) => Effect.annotateLogs(effect, { x, y }),
);
```

## Avoid try / catch

Use `Effect.try` / `Effect.tryPromise`:

```ts
import { Effect, Schema } from 'effect';

class JsonError extends Schema.TaggedError<JsonError>('JsonError')({
	cause: Schema.Defect,
}) {}

Effect.gen(function* () {
	const result = yield* Effect.try({
		try: () => JSON.parse('{"invalidJson": }'),
		catch: (cause) => new JsonError({ cause }),
	});
	const asyncResult = yield* Effect.tryPromise({
		try: () => fetch('https://api.example.com/data').then((res) => res.json()),
		catch: (cause) => new JsonError({ cause }),
	});
	return { result, asyncResult };
});
```

## Error handling

- `Effect.catchAll` — handle all errors
- `Effect.catchAllCause` — including defects
- `Effect.catchTag` / `Effect.catchTags` — handle specific tagged errors
- `Effect.catchIf` — conditional

```ts
import { Effect, Schema } from 'effect';

class ErrorA extends Schema.TaggedError<ErrorA>('ErrorA')({ cause: Schema.Defect }) {}
class ErrorB extends Schema.TaggedError<ErrorB>('ErrorB')({ cause: Schema.Defect }) {}

someEffect.pipe(
	Effect.catchTag('ErrorA', (e) => Effect.log('Caught ErrorA:', e)),
	Effect.catchTags({
		ErrorA: (e) => Effect.log('A', e),
		ErrorB: (e) => Effect.log('B', e),
	}),
);
```

## Services (the most important pattern)

**Most Effect code should be written as services.** Services bundle related Effect functions and let
Effect's DI system wire them up.

```ts
import { Effect, Schema } from 'effect';

export class Database extends Effect.Service<Database>()('Database', {
	dependencies: [],
	// ESSENTIAL: always use `scoped:` — it gives the service a Scope for finalizers
	scoped: Effect.gen(function* () {
		const query = Effect.fn('Database.query')(function* (sql: string) {
			yield* Effect.annotateCurrentSpan({ sql });
			return { rows: [] };
		});
		// Return methods with `as const` for type safety
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

### One `Effect.provide` per app

**Essential**: there should be exactly one `Effect.provide` in an Effect application, at the top
level. Compose multiple Layers with the `Layer` module rather than scattering `provide` calls.

## Defining domain entities with Schema

```ts
import { Schema } from 'effect';

export const UserId = Schema.String.pipe(
	Schema.brand('UserId', { description: 'A unique identifier for a user' }),
);
export type UserId = (typeof UserId).Type;

export class User extends Schema.Class<User>('User')({
	id: UserId,
	name: Schema.String,
	email: Schema.String,
	createdAt: Schema.DateTimeUtc, // prefer DateTimeUtc for date/time fields
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

## Testing

Use `@effect/vitest`. In v4 the primary test runner is `it.effect` — it implicitly provides a
`Scope` so most tests don't need a separate `it.scoped`. `it.live` runs against the live clock;
`it.layer(layer)('group', (it) => {...})` shares a Layer across nested tests.

```ts
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

describe('My Effect tests', () => {
	it.effect('runs an Effect and asserts the result', () =>
		Effect.gen(function* () {
			const result = yield* Effect.succeed('Hello, World!');
			expect(result).toBe('Hello, World!');
		}),
	);

	it.effect('handles errors with Effect.flip', () =>
		Effect.gen(function* () {
			const error = yield* Effect.fail('An error occurred').pipe(Effect.flip);
			expect(error).toBe('An error occurred');
		}),
	);
});
```

- `@effect/vitest` re-exports all of vitest, so `describe`, `expect`, `it`, etc. come from it. There
  is no `assert` export — use `expect`.
- Never use `Effect.runSync` inside `it`; use `it.effect` instead.

## Common v4 modules (devstack will lean on)

- **`effect`** core: `Effect`, `Layer`, `Scope`, `Schedule`, `Pool`, `Semaphore`, `Queue`, `Schema`,
  `Stream`, `FileSystem`, `Path`.
- **`@effect/platform-node`**: `NodeRuntime`, `NodeFileSystem`, `NodePath`,
  `NodeChildProcessSpawner` — the Node-side bindings for the platform abstractions.
- **`effect/unstable/process`**: `ChildProcess`, `ChildProcessSpawner` — the platform-neutral
  child-process abstraction (Node binding lives in `@effect/platform-node`).
- **`effect/unstable/cli`**: `Command`, `Args`, `Options` — for `devstack up`-style commands.
- **`@effect/vitest`**: `it.effect`, `it.live`, `it.layer`, plus all of vitest re-exported
  (`describe`, `expect`).

Reminder: when in doubt, grep `repos/effect-v4/packages/effect/src/` (and
`repos/effect-v4/packages/platform-node/src/` for the Node bindings). The source is the source of
truth.
