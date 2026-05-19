// `devstack graph` — print the static dep graph for the configured stack
// (Phase G of `notes/parallel-graph-resolution.md` §6.7). Three formats:
//
//   - `text` (default) — one line per topological level; siblings on the
//     same level separated by `, `. Mirrors what the TUI dep-tree shows
//     on startup so operators can preview the build plan before invoking
//     `up`. Compact + diff-friendly.
//   - `mermaid` — Mermaid flowchart syntax. Pipes cleanly into a Markdown
//     code-fence (` ```mermaid `) for GitHub / docs.
//   - `dot` — Graphviz DOT for `dot -Tsvg | open`-style local rendering.
//
// Read-only — does NOT build any layers / acquire any primitives, so it's
// safe to run against a stack that's already up. Resolution path:
//
//   1. Dynamic-import the user's `devstack.config.ts` (walks up from cwd
//      to find one, matching `up` / `apply`).
//   2. Pull `.config.stack` off the resolved DevstackHandle.
//   3. Flatten composites' `__extraMembers` so the printed graph
//      reflects what `composeStackLayer` actually composes — without the
//      flatten, walrus's lifted `upstreamImage` / `moveSource` siblings
//      (Phase D) wouldn't appear as their own nodes.
//   4. Build the dep graph + topological levels via
//      `buildDepGraph` / `topoLevels`.
//   5. Render to the requested format.

import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import {
	buildDepGraph,
	computeDownstreamClosure,
	topoLevels,
	type DepGraph,
} from '../../engine/dep-graph.js';
import { flattenStackMembers, type StackMember } from '../../engine/supervisor.js';
import { failAlreadyReported } from '../already-reported.js';
import { loadConfigModule } from '../loaders.js';
import type { DevstackConfig } from '../../engine/supervisor.js';

// The graph command needs `.config.stack` (NOT `.launchEffect` /
// `.layer`), so a focused validator that pulls the stack off the handle.
// Mirrors the shape `requireLaunchEffect` / `requireLayer` validate
// against — same default export contract, different field assertion.
interface DevstackGraphable {
	readonly config: DevstackConfig;
}

const requireConfig = (configPath: string, mod: unknown): DevstackGraphable => {
	const d = (mod as { default?: unknown } | undefined)?.default as
		| Partial<DevstackGraphable>
		| undefined;
	if (
		d === undefined ||
		d.config === undefined ||
		!Array.isArray((d.config as { stack?: unknown }).stack)
	) {
		throw new Error(
			`${configPath} must default-export a DevstackHandle (from devstack(...) or defineDevstack)`,
		);
	}
	return d as DevstackGraphable;
};

// Display title preferred over the engine-internal key for human output.
// Mirrors the TUI's seed-pass fallback: `__displayTitle` first (the
// friendly label set via `provide({displayTitle})`), key second.
const displayTitle = (m: StackMember | undefined, key: string): string =>
	(m as { __displayTitle?: string } | undefined)?.__displayTitle ?? key;

/** Render the graph as a per-level text summary (one line per
 *  topological level, sibling keys comma-separated). Exported for
 *  unit tests + the TUI dep-tree (Phase G §6.7) — they format identically. */
export const renderText = (
	graph: DepGraph,
	levels: ReadonlyArray<ReadonlyArray<string>>,
	memberByKey: ReadonlyMap<string, StackMember>,
): string => {
	const lines: string[] = [];
	lines.push(`devstack graph — ${graph.size} member(s), ${levels.length} level(s)`);
	for (let i = 0; i < levels.length; i++) {
		const level = levels[i]!;
		const titles = level.map((k) => displayTitle(memberByKey.get(k), k));
		lines.push(`  level ${i}: ${titles.join(', ')}`);
	}
	return lines.join('\n');
};

// Mermaid escapes: `[`, `]`, `"` would close the node-label brackets.
// `id` must be alphanumeric-with-dots (mermaid accepts a subset); keys
// like `@devstack/SuiTag` need sanitising to `_devstack_SuiTag`. The
// human label survives intact in the `["..."]` body.
const sanitiseMermaidId = (k: string): string => k.replace(/[^a-zA-Z0-9]/g, '_');
const escapeMermaidLabel = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Render the graph as Mermaid `flowchart TD` syntax. Exported for unit
 *  tests. Drop the body into a Markdown ` ```mermaid ` fence for
 *  GitHub / docs rendering. */
export const renderMermaid = (
	graph: DepGraph,
	memberByKey: ReadonlyMap<string, StackMember>,
): string => {
	const lines: string[] = ['flowchart TD'];
	for (const [key, node] of graph) {
		const id = sanitiseMermaidId(key);
		const label = escapeMermaidLabel(displayTitle(memberByKey.get(key), key));
		lines.push(`    ${id}["${label}"]`);
		for (const up of node.upstreamKeys) {
			lines.push(`    ${sanitiseMermaidId(up)} --> ${id}`);
		}
	}
	return lines.join('\n');
};

const escapeDotLabel = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Render the graph as Graphviz DOT syntax. Exported for unit tests.
 *  Pipe through `dot -Tsvg | open` (macOS) / `xdg-open` (Linux) to
 *  get an SVG. */
export const renderDot = (
	graph: DepGraph,
	memberByKey: ReadonlyMap<string, StackMember>,
): string => {
	const lines: string[] = ['digraph devstack {', '  rankdir=LR;', '  node [shape=box];'];
	for (const [key, node] of graph) {
		const id = sanitiseMermaidId(key);
		const label = escapeDotLabel(displayTitle(memberByKey.get(key), key));
		lines.push(`  ${id} [label="${label}"];`);
		for (const up of node.upstreamKeys) {
			lines.push(`  ${sanitiseMermaidId(up)} -> ${id};`);
		}
	}
	lines.push('}');
	return lines.join('\n');
};

export const graphCommand = Command.make(
	'graph',
	{
		configPath: Argument.string('config-path').pipe(Argument.optional),
		// Format selection. Accepts `text` (default) / `mermaid` / `dot`.
		// Effect-CLI doesn't ship a `Flag.choice` helper here; we accept
		// `Flag.string` and validate at the top of the action so the
		// error message names the legal set instead of failing later.
		format: Flag.string('format').pipe(
			Flag.withDescription(
				'Output format: text (default), mermaid, or dot (Graphviz). Pipe to `dot -Tsvg` for an image.',
			),
			Flag.optional,
		),
		// `--downstream <key>` — print the strictly-downstream closure
		// of a single primitive. Useful for "what restarts when I edit
		// this?" introspection without standing up the supervisor.
		downstream: Flag.string('downstream').pipe(
			Flag.withDescription(
				'Print the strictly-downstream closure for the named key (membership in --format=text)',
			),
			Flag.optional,
		),
	},
	({ configPath, format, downstream }) =>
		Effect.gen(function* () {
			const resolved = Option.getOrElse(configPath, () => './devstack.config.ts');
			const handle = yield* loadConfigModule(resolved, requireConfig);

			// Flatten composites' `__extraMembers` (Phase D) so the
			// graph reflects what `composeStackLayer` builds — without
			// this, lifted siblings (walrus's `upstreamImage`, seal's
			// `sealImage`, …) would be invisible.
			const flatStack = flattenStackMembers(handle.config.stack);
			const memberByKey = new Map<string, StackMember>();
			for (const m of flatStack) {
				const key = (m as { key?: string }).key;
				if (key !== undefined && !memberByKey.has(key)) memberByKey.set(key, m);
			}

			const graph = buildDepGraph(flatStack);

			// `--downstream <key>` mode: print just the closure for one
			// node. Independent of `--format` — closure rendering is
			// text-only (a bullet list); other formats render the full
			// graph.
			const downstreamKey = Option.getOrUndefined(downstream);
			if (downstreamKey !== undefined) {
				const closure = computeDownstreamClosure(graph);
				const downstreamSet = closure.get(downstreamKey);
				if (downstreamSet === undefined) {
					return yield* failAlreadyReported(
						`devstack graph: key '${downstreamKey}' not found in stack graph. ` +
							`Known keys: ${Array.from(graph.keys()).join(', ')}`,
					);
				}
				yield* Console.log(
					`downstream of ${displayTitle(memberByKey.get(downstreamKey), downstreamKey)} ` +
						`(${downstreamSet.size} consumer${downstreamSet.size === 1 ? '' : 's'}):`,
				);
				for (const k of downstreamSet) {
					yield* Console.log(`  - ${displayTitle(memberByKey.get(k), k)}`);
				}
				return;
			}

			const formatStr = Option.getOrElse(format, () => 'text');
			if (formatStr !== 'text' && formatStr !== 'mermaid' && formatStr !== 'dot') {
				return yield* failAlreadyReported(
					`devstack graph: unknown format '${formatStr}' (legal: text, mermaid, dot)`,
				);
			}

			if (formatStr === 'mermaid') {
				yield* Console.log(renderMermaid(graph, memberByKey));
				return;
			}
			if (formatStr === 'dot') {
				yield* Console.log(renderDot(graph, memberByKey));
				return;
			}
			yield* Console.log(renderText(graph, topoLevels(graph), memberByKey));
		}),
).pipe(
	Command.withDescription(
		"Print the static dep graph for the configured stack (read-only — doesn't build layers)",
	),
);
