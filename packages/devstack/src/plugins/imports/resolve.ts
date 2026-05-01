// Recursive Move.toml dep walker. Given a list of top-level imports,
// returns a topo-sorted list of every transitively-required git package
// that needs to be published.
//
// Policy decisions:
// - Local (`{ local = "..." }`) deps are NOT enqueued for separate
//   publishing — they live inside the parent's source tree and get
//   published as part of `--with-unpublished-dependencies` automatically.
//   They DO contribute to the topo edge set (via the parent), but they
//   don't create new resolved entries.
// - Framework-style git deps pointing at MystenLabs/sui (any rev) are
//   skipped — the localnet container ships its own framework and would
//   reject re-publishing.
// - Dedup key is `(repo, rev, subdir)`. A package required at two revs
//   becomes two entries; the resolver does NOT attempt to unify revs.
//   Authors are expected to pin to a single rev across the dep graph.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureUpstreamSourceImage, extractUpstreamSource } from '../../helpers/upstream-source.js';
import { type GitDep, parseMoveToml } from './move-toml.js';

export interface ResolveSeed {
	name: string;
	repo: string;
	rev: string;
	subdir: string;
}

export interface ResolvedImport {
	/** Stable key — `<repo>@<rev>:<subdir>`. */
	key: string;
	/** Logical name. Top-level imports keep their declared name; transitive
	 * deps use the Move.toml dependency key (lowercased). */
	name: string;
	repo: string;
	rev: string;
	subdir: string;
	/** Resolved keys this entry depends on. Topo edges. */
	depKeys: string[];
}

export interface ResolveResult {
	/** Topo-sorted: deps before dependents. */
	resolved: ResolvedImport[];
}

const FRAMEWORK_REPOS = new Set(['MystenLabs/sui', 'MystenLabs/sui.git']);

function makeKey(repo: string, rev: string, subdir: string): string {
	return `${repo}@${rev}:${subdir}`;
}

export async function resolveImports(seeds: ResolveSeed[]): Promise<ResolveResult> {
	const resolved = new Map<string, ResolvedImport>();
	const queue: Array<{ entry: ResolveSeed; isSeed: boolean }> = seeds.map((s) => ({
		entry: s,
		isSeed: true,
	}));

	while (queue.length > 0) {
		const { entry, isSeed } = queue.shift() ?? { entry: seeds[0]!, isSeed: true };
		const key = makeKey(entry.repo, entry.rev, entry.subdir);
		if (resolved.has(key)) continue;

		const moveToml = await readMoveTomlAt(entry.repo, entry.rev, entry.subdir);
		const parsed = parseMoveToml(moveToml);

		const childGitDeps: GitDep[] = parsed.deps.filter(
			(d): d is GitDep => d.kind === 'git' && !FRAMEWORK_REPOS.has(d.repo),
		);
		const depKeys: string[] = [];
		for (const dep of childGitDeps) {
			const depKey = makeKey(dep.repo, dep.rev, dep.subdir);
			depKeys.push(depKey);
			if (!resolved.has(depKey)) {
				queue.push({
					entry: {
						name: isSeed ? `${entry.name}-${dep.name.toLowerCase()}` : dep.name.toLowerCase(),
						repo: dep.repo,
						rev: dep.rev,
						subdir: dep.subdir,
					},
					isSeed: false,
				});
			}
		}

		resolved.set(key, {
			key,
			name: entry.name,
			repo: entry.repo,
			rev: entry.rev,
			subdir: entry.subdir,
			depKeys,
		});
	}

	return { resolved: topoSort(resolved) };
}

async function readMoveTomlAt(repo: string, rev: string, subdir: string): Promise<string> {
	// Reject `..` segments and absolute paths in `subdir` — a malicious
	// upstream Move.toml could declare `subdir = "../../etc"` and `join`
	// would happily escape the tmp dir, letting us read host files. The
	// realistic subset uses only flat, repo-relative segments.
	if (subdir.includes('..') || subdir.startsWith('/')) {
		throw new Error(
			`resolveImports: refusing to walk subdir '${subdir}' for ${repo}@${rev} ` +
				'(contains ".." or absolute path; that would escape the source-image extraction dir).',
		);
	}
	const { imageTag } = await ensureUpstreamSourceImage({ repo, rev });
	const tmp = mkdtempSync(join(tmpdir(), 'devstack-resolve-'));
	try {
		await extractUpstreamSource({ imageTag, destDir: tmp });
		const tomlPath = join(tmp, subdir, 'Move.toml');
		if (!existsSync(tomlPath)) {
			throw new Error(`resolveImports: Move.toml missing at ${repo}@${rev}:${subdir}`);
		}
		return readFileSync(tomlPath, 'utf8');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function topoSort(resolved: Map<string, ResolvedImport>): ResolvedImport[] {
	const out: ResolvedImport[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function visit(key: string): void {
		if (visited.has(key)) return;
		if (visiting.has(key)) {
			throw new Error(`resolveImports: cycle detected involving ${key}`);
		}
		visiting.add(key);
		const node = resolved.get(key);
		if (node !== undefined) {
			for (const depKey of node.depKeys) {
				if (resolved.has(depKey)) visit(depKey);
			}
			out.push(node);
		}
		visiting.delete(key);
		visited.add(key);
	}

	for (const key of resolved.keys()) visit(key);
	return out;
}
