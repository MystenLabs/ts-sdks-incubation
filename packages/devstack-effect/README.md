# @mysten-incubation/devstack-effect

Experimental, parallel reimplementation of [`@mysten-incubation/devstack`](../devstack/) built on
[Effect](https://effect.website) (v4 beta).

This package is a spike. The goal is to evaluate Effect's `Layer` / `Scope` / `Schedule` / `Schema`
against the hand-rolled lifecycle, retry, and config validation in the original devstack — not to
replace it. Both packages will coexist while we compare them.

## Status

- **Day 1**: empty shell. No supervisor, no runners, no plugins, no CLI yet.
- **Next**: rebuild one runner (`hostProcess`) as an `Effect.Service` with `scoped:` lifecycle,
  side-by-side with `packages/devstack/src/runners/host-process.ts`.

## Agent guide

If you're an AI coding agent (Claude Code, Cursor, etc.) editing this package, read
[`AGENTS.md`](./AGENTS.md) first. The repo's `.mcp.json` also registers the
[`effect-mcp`](https://github.com/tim-smart/effect-mcp) server — use the `effect_docs_search` tool
for authoritative Effect documentation.

## Why Effect, why parallel

See [`/Users/michaelhayes/.claude/plans/ticklish-wiggling-peach.md`](../../) (local plan file) for
the scope decision. Short version: devstack has tangled async lifecycles, ad-hoc retry, manual port
allocation, and mixed throw/return error paths — all things Effect was designed for. Rather than
migrate in place, we're building alongside so we can compare honestly and roll back without churn if
Effect doesn't pay off.
