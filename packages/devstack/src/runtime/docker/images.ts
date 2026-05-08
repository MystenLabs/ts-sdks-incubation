// Image-management primitives — existence probes, label-scoped GC,
// dangling-image prune, BuildKit cache prune, and the low-level
// `buildContainerImage` wrapper around `docker build`.
//
// NOTE: `buildContainerImage` is the docker primitive, NOT the Build-action
// factory (which is `buildImage` in `../actions/build.ts`, exported via
// `/authoring`). Plugin authors shipping their own Dockerfile call this
// primitive from inside an action's `run` callback.

import { dockerRun } from './run.js';

/** Returns true when the image tag is present in the local docker daemon.
 * Lets `runDocker`'s ENOENT-aware error surface to callers when docker
 * itself is missing — masking that as "image absent" would silently
 * trigger a build action that's also doomed. */
export async function imageExists(tag: string): Promise<boolean> {
	const result = await dockerRun({
		command: ['image', 'inspect', tag, '--format', '{{.Id}}'],
	});
	return result.code === 0;
}

/** Repository:tag pair returned by `docker image ls --filter`. Used by
 * the cache-GC helpers to enumerate candidates before targeted removal. */
export interface ImageRef {
	/** `<repository>:<tag>`. Pass to `removeImage`. */
	ref: string;
	repository: string;
	tag: string;
	id: string;
}

/** List images carrying every label in `labels` (Docker AND-joins
 * multiple `--filter label=...` flags). An empty-string value matches
 * the label key regardless of its value (docker syntax: `label=key`
 * vs. `label=key=value`). Skips dangling rows where `Repository` or
 * `Tag` is `<none>` — those are intermediate layers that shouldn't be
 * tag-removed individually. Also skips `devstack-snapshot/*` rows:
 * snapshot commits inherit their parent image's labels (`docker commit`
 * carries `devstack.cache=...` forward), but they're a separate user
 * concern managed by `devstack snapshot rm` rather than part of the
 * build cache. Returns empty on docker error so callers can treat the
 * result as "no work to do" without raising. */
export async function listImagesByLabel(labels: Record<string, string>): Promise<ImageRef[]> {
	const command = ['image', 'ls', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}'];
	for (const [k, v] of Object.entries(labels)) {
		command.push('--filter', v === '' ? `label=${k}` : `label=${k}=${v}`);
	}
	const result = await dockerRun({ command });
	if (result.code !== 0) return [];
	const out: ImageRef[] = [];
	for (const line of result.stdout.split('\n')) {
		const [repository, tag, id] = line.split('\t');
		if (
			repository === undefined ||
			tag === undefined ||
			id === undefined ||
			repository === '<none>' ||
			tag === '<none>' ||
			repository.length === 0 ||
			repository.startsWith('devstack-snapshot/')
		) {
			continue;
		}
		out.push({ ref: `${repository}:${tag}`, repository, tag, id });
	}
	return out;
}

/** Best-effort `docker image rm <tag>`. Swallows failures (image in use
 * by a running container, dependent child image like a snapshot tag,
 * race with a parallel pull) so callers can prune a list without one
 * stuck tag aborting the rest. Returns `true` on success. */
export async function removeImage(tag: string): Promise<boolean> {
	const result = await dockerRun({ command: ['image', 'rm', tag] });
	return result.code === 0;
}

/** Drop every image matching the `labels` filter set whose
 * `repository:tag` is NOT in `keep`. Used post-build to GC superseded
 * revs that share the cache label (e.g. drop `sui-localnet:devnet-v1.71.0-r6`
 * after `r7` builds successfully). No `--force`: in-use tags survive,
 * so the operator can clean up later via the explicit
 * `devstack wipe --images` path. Each removal logs `pruned <ref>` /
 * `kept <ref> (in use)` via `appendLog` for visibility. */
export async function pruneImagesByLabel(opts: {
	labels: Record<string, string>;
	keep: string[];
	appendLog?: (line: string) => void;
}): Promise<void> {
	const candidates = await listImagesByLabel(opts.labels);
	const keepSet = new Set(opts.keep);
	for (const img of candidates) {
		if (keepSet.has(img.ref)) continue;
		const ok = await removeImage(img.ref);
		if (ok) {
			opts.appendLog?.(`devstack: pruned cached image ${img.ref}`);
		} else {
			opts.appendLog?.(`devstack: kept ${img.ref} (in use or has dependents)`);
		}
	}
}

/** Run `docker image prune -f --filter label=devstack.cache` to drop
 * untagged image layers (manifests whose only tag was removed) that
 * were devstack-built. Without this, `removeImage` calls leave dangling
 * layer entries in `docker image ls` — the disk space stays allocated
 * until the next `docker image prune`. Returns the docker output (which
 * ends with `Total reclaimed space: <N>`) and an ok flag. Best-effort:
 * `ok: false` on docker error rather than throwing. */
export async function pruneDanglingDevstackImages(): Promise<{ output: string; ok: boolean }> {
	const result = await dockerRun({
		command: ['image', 'prune', '-f', '--filter', 'label=devstack.cache'],
	});
	return { output: result.stdout.trim(), ok: result.code === 0 };
}

/** Run `docker builder prune -f` to evict BuildKit cache layers that
 * are no longer referenced by any image tag. Without this, `removeImage`
 * frees the tag but the cargo-build cache that backed it stays in
 * BuildKit's separate cache forever — a fresh rebuild then short-circuits
 * through cache instead of re-running the actual build steps the
 * operator is trying to retest. NOT scoped by label: `docker builder
 * prune` doesn't accept image-label filters, so this is a host-wide
 * sweep of unused cache. Safe in the sense that "in use" cache (anything
 * referenced by a current image manifest) survives. Returns docker output
 * + ok flag. Best-effort. */
export async function pruneBuildCache(): Promise<{ output: string; ok: boolean }> {
	const result = await dockerRun({ command: ['builder', 'prune', '-f'] });
	return { output: result.stdout.trim(), ok: result.code === 0 };
}

/** Total reclaimable BuildKit cache size as a human-readable string
 * (e.g. `'26.85GB'`). Used by `--images --dry-run` to report how much
 * space the eventual `pruneBuildCache` call would free, without
 * actually freeing it. Returns `undefined` on docker error (graceful
 * degradation — dry-run is best-effort information). */
export async function buildCacheSize(): Promise<string | undefined> {
	const result = await dockerRun({ command: ['buildx', 'du'] });
	if (result.code !== 0) return undefined;
	const match = result.stdout.match(/Reclaimable:\s*(\S+)/);
	return match?.[1];
}

export interface BuildContainerImageOptions {
	tag: string;
	contextDir: string;
	dockerfile?: string;
	buildArgs?: Record<string, string>;
	/** Docker labels to attach to the built image. Used to filter caches
	 * via `docker image ls --filter label=devstack.cache=<kind>`. */
	labels?: Record<string, string>;
	/** Build platform (e.g. `'linux/arm64'`). Forwarded as `--platform`. */
	platform?: string;
	/** BuildKit named contexts as `--build-context name=value` flags
	 * (e.g. `{ 'walrus-src': 'https://github.com/.../walrus.git#v1' }`).
	 * Lets the Dockerfile reference `--from=name` for `COPY` operations
	 * without baking the source into the on-disk build context. */
	buildContexts?: Record<string, string>;
	/** Route docker's combined stdout/stderr through the supervisor's
	 * status renderer. When unset, build output falls back to raw
	 * `process.stderr` (see `DockerRunOptions.appendLog`). */
	appendLog?: (line: string) => void;
}

/** Low-level `docker build` wrapper. The matching Build-action factory
 * is `buildImage` in `actions/build.ts`, exported from `/authoring`;
 * plugin authors shipping their own Dockerfile call THIS primitive
 * from inside their action's `run` callback (see the `sui.build`
 * action for the canonical pattern). */
export async function buildContainerImage(opts: BuildContainerImageOptions): Promise<void> {
	const args = ['build', '--tag', opts.tag];
	for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
		args.push('--build-arg', `${k}=${v}`);
	}
	for (const [k, v] of Object.entries(opts.labels ?? {})) {
		args.push('--label', `${k}=${v}`);
	}
	for (const [k, v] of Object.entries(opts.buildContexts ?? {})) {
		args.push('--build-context', `${k}=${v}`);
	}
	if (opts.platform !== undefined) {
		args.push('--platform', opts.platform);
	}
	if (opts.dockerfile !== undefined) {
		args.push('--file', opts.dockerfile);
	}
	args.push(opts.contextDir);
	const result = await dockerRun({ command: args, stream: true, appendLog: opts.appendLog });
	if (result.code !== 0) {
		throw new Error(`docker build failed (exit ${result.code}): ${result.stderr.slice(-400)}`);
	}
}
