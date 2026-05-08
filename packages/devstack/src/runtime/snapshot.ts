// Snapshot save/restore for a stack.
//
// Mechanism: `docker commit` each running container labeled for the stack
// into a fresh seed image, then copy the host-side `<stackDir>` into the
// snapshot bundle. Restore is symmetric: re-tag the seed images back to
// the original image tags (so the plugin's `docker run` from its
// hardcoded image name picks up the seeded layer), then restore
// `<stackDir>` from the bundle.
//
// On-disk layout:
//
//   <appDir>/.devstack/snapshots/
//     aliases/
//       <human-name> -> ../<sha-id>     (symlink)
//     <sha-id>/
//       snapshot.json
//       host/                            (recursive copy of <stackDir>)
//
// `<sha-id>` is content-addressed by the canonical inputs (plugin
// versions, base image tags, account specs, platform). Identical inputs
// produce identical IDs; bumping any input → different ID → cache miss
// by construction.

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { inspectContainer, startContainer, stopContainer } from './docker/index.js';
import { dockerRun } from './docker/run.js';
import { stableHash } from './hash.js';
import { stackDir } from './active-stack.js';

interface SnapshotContainerEntry {
	/** Container name as it existed at capture time (e.g.,
	 * `token-studio-main-sui`). Restore re-creates the container under
	 * this name on the next `devstack up`. */
	containerName: string;
	/** Image tag the container was originally created from (e.g.,
	 * `mysten-devstack/sui-localnet:devnet-v1.71.0-r8`). Restore re-tags
	 * `seedImage` to this so the plugin's `docker run` from its
	 * hardcoded tag picks up the seeded layer. */
	originalImage: string;
	/** Image tag we committed the container into (e.g.,
	 * `devstack-snapshot/<sha-id>/token-studio-main-sui:seeded`). Lives
	 * in the local docker daemon's image store. */
	seedImage: string;
	/** Optional registry tag the seed image was pushed to via
	 * `snapshot save --push <registry>`. When set, restore can pull from
	 * the registry if the local seed image is missing — the canonical
	 * mechanism for CI / cross-machine snapshot sharing. */
	registryImage?: string;
}

interface SnapshotEntry {
	id: string;
	alias?: string;
	createdAt: string;
	platform: string;
	stack: string;
	appName: string;
	containers: SnapshotContainerEntry[];
}

interface SnapshotIdInput {
	appName: string;
	stack: string;
	/** Stable per-plugin metadata (name + version + options) used to derive
	 * a content hash. Plugin authors should pass the user-facing options
	 * + any image tags / revisions. */
	plugins: ReadonlyArray<{ name: string; version?: string; inputs?: unknown }>;
	/** Account names declared in the config (order-stable). */
	accountNames: string[];
	/** Sui base image tag (or whatever the per-stack canonical chain image is). */
	suiImage?: string;
	platform: string;
}

/** Compute the content-addressed snapshot id from the canonical inputs.
 * Reuses `stableHash` so the canonicalization rules (sorted keys,
 * deterministic stringification) match the rest of the runtime. */
export function computeSnapshotId(input: SnapshotIdInput): string {
	return stableHash([
		'devstack-snapshot:v1',
		input.appName,
		input.stack,
		input.platform,
		input.suiImage ?? null,
		input.accountNames.slice().sort(),
		input.plugins
			.map((p) => ({ name: p.name, version: p.version ?? null, inputs: p.inputs ?? null }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	]);
}

const snapshotsRoot = (appDir: string): string => resolve(appDir, '.devstack', 'snapshots');
const snapshotDir = (appDir: string, id: string): string => resolve(snapshotsRoot(appDir), id);
const aliasDir = (appDir: string): string => resolve(snapshotsRoot(appDir), 'aliases');
const aliasPath = (appDir: string, alias: string): string => resolve(aliasDir(appDir), alias);
const seedImageTag = (id: string, containerName: string): string =>
	`devstack-snapshot/${id}/${containerName}:seeded`;

interface CaptureOptions {
	appName: string;
	appDir: string;
	stack: string;
	id: string;
	alias?: string;
	/** Containers labeled with this stack get committed. Defaults to
	 * label-based discovery via `dockerRun(['ps', '-a', '--filter',
	 * 'label=devstack.app=<a>', '--filter', 'label=devstack.stack=<s>'])`. */
	containerNames?: string[];
	/** When set, also tag each seed image as
	 * `<registry>/<container>:<alias-or-id>` and `docker push`. Recorded
	 * in `snapshot.json` so restore can pull from the registry on a
	 * machine where the local seed image is absent (the CI / cross-host
	 * sharing path). Requires the operator to have `docker login` against
	 * the registry. */
	pushTo?: string;
}

/** Capture the current state of a stack as a snapshot. For each labeled
 * container: read its `devstack.snapshot.*` labels for per-container
 * commit/quiesce policy, quiesce per the policy, `docker commit` (when
 * commit=true), then restart. Copies `<stackDir>` into the bundle.
 *
 * Per-container defaults when labels are absent: commit=true,
 * quiesce='stop'. Plugin authors override via `containerService.snapshot`
 * (e.g., `commit: false` for stateless containers like seal/walrus.proxy
 * or `quiesce: 'pause'` for sui's RocksDB). */
export async function captureSnapshot(opts: CaptureOptions): Promise<SnapshotEntry> {
	const containerNames =
		opts.containerNames ?? (await listStackContainers(opts.appName, opts.stack));
	if (containerNames.length === 0) {
		throw new Error(
			`captureSnapshot: no containers labeled devstack.app=${opts.appName} ` +
				`devstack.stack=${opts.stack}. Bring the stack up first with \`devstack up\`.`,
		);
	}

	// Inspect each container once for state + labels.
	const inspected = await Promise.all(
		containerNames.map(async (n) => ({
			name: n,
			info: await inspectContainer(n),
			labels: await readContainerLabels(n),
		})),
	);

	// Quiesce in reverse-discovery order so the leaves stop before the
	// services that depend on them. `pause` is essentially instant; `stop`
	// waits for graceful SIGTERM. Containers we'll later restart get
	// recorded in `wasPaused`/`wasRunning` so the un-quiesce step matches.
	const wasPaused = new Set<string>();
	const wasRunning = new Set<string>();
	for (let i = inspected.length - 1; i >= 0; i--) {
		const entry = inspected[i];
		if (entry === undefined || entry.info?.running !== true) continue;
		const quiesce = parseQuiesce(entry.labels);
		if (quiesce === 'pause') {
			wasPaused.add(entry.name);
			await pauseContainer(entry.name);
		} else if (quiesce === 'stop') {
			wasRunning.add(entry.name);
			await stopContainer(entry.name);
		}
		// 'none' → no-op
	}

	const aliasOrId = opts.alias ?? opts.id.slice(0, 16);
	const containers: SnapshotContainerEntry[] = [];
	for (const entry of inspected) {
		if (entry.info === null || entry.info === undefined) continue;
		const commit = parseCommit(entry.labels);
		if (!commit) continue;
		const seedImage = seedImageTag(opts.id, entry.name);
		const result = await dockerRun({
			command: ['commit', entry.name, seedImage],
		});
		if (result.code !== 0) {
			throw new Error(
				`captureSnapshot: docker commit failed for ${entry.name} → ${seedImage}: ${result.stderr.trim()}`,
			);
		}
		const containerEntry: SnapshotContainerEntry = {
			containerName: entry.name,
			originalImage: entry.info.image,
			seedImage,
		};
		if (opts.pushTo !== undefined) {
			const registryImage = `${opts.pushTo.replace(/\/$/, '')}/${entry.name}:${aliasOrId}`;
			const tag = await dockerRun({ command: ['tag', seedImage, registryImage] });
			if (tag.code !== 0) {
				throw new Error(
					`captureSnapshot: docker tag ${seedImage} → ${registryImage} failed: ${tag.stderr.trim()}`,
				);
			}
			const push = await dockerRun({ command: ['push', registryImage], stream: true });
			if (push.code !== 0) {
				throw new Error(
					`captureSnapshot: docker push ${registryImage} failed (exit ${push.code}). ` +
						`Did you \`docker login ${opts.pushTo.split('/')[0]}\`?`,
				);
			}
			containerEntry.registryImage = registryImage;
		}
		containers.push(containerEntry);
	}

	// Un-quiesce: paused → unpause; stopped → start. Best-effort — a
	// failure here doesn't invalidate the snapshot, just leaves the
	// operator to bring the stack back up themselves.
	for (const entry of inspected) {
		if (wasPaused.has(entry.name)) {
			await unpauseContainer(entry.name).catch(() => undefined);
		} else if (wasRunning.has(entry.name)) {
			await startContainer(entry.name).catch(() => undefined);
		}
	}

	// Stage the bundle in a sibling tmp directory and publish it via a
	// single `renameSync`. Without this two-step, a `kill -9` between the
	// host-dir copy and the manifest write leaves a half-formed bundle on
	// disk: `host/` present, `snapshot.json` absent → the next `restore`
	// finds the snapshot dir but errors with no diagnostic. Atomic publish
	// means partial state is invisible to readers.
	const dir = snapshotDir(opts.appDir, opts.id);
	const stagingDir = `${dir}.staging.${process.pid}`;
	if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	let published = false;
	const entry: SnapshotEntry = {
		id: opts.id,
		alias: opts.alias,
		createdAt: new Date().toISOString(),
		platform: `${process.platform}/${process.arch}`,
		stack: opts.stack,
		appName: opts.appName,
		containers,
	};
	try {
		const hostSrc = stackDir(opts.appDir, opts.stack);
		const hostDst = resolve(stagingDir, 'host');
		if (existsSync(hostSrc)) {
			cpSync(hostSrc, hostDst, { recursive: true });
		} else {
			mkdirSync(hostDst, { recursive: true });
		}
		writeManifestAtomic(resolve(stagingDir, 'snapshot.json'), entry);

		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		renameSync(stagingDir, dir);
		published = true;
	} finally {
		if (!published && existsSync(stagingDir)) {
			rmSync(stagingDir, { recursive: true, force: true });
		}
	}

	if (opts.alias !== undefined) {
		writeAlias(opts.appDir, opts.alias, opts.id);
	}

	return entry;
}

interface RestoreOptions {
	appName: string;
	appDir: string;
	stack: string;
	/** Either content-addressed sha-id or alias name. Aliases resolve via
	 * the symlink layer under `<appDir>/.devstack/snapshots/aliases/`. */
	ref: string;
	/** Skip the cross-arch refusal. The arch check protects against
	 * RocksDB binary-format mismatches between e.g. darwin/arm64 dev
	 * snapshots and linux/amd64 CI runners. */
	forceArch?: boolean;
}

/** Restore a snapshot. Refuses if any container labeled for the target
 * stack is still running — operator must `devstack stack down` first.
 * Re-tags each seed image back to its original tag so the plugin's next
 * `docker run` picks up the seeded layer. Replaces `<stackDir>` from
 * the bundle. */
export async function loadSnapshot(opts: RestoreOptions): Promise<SnapshotEntry> {
	const id = resolveAlias(opts.appDir, opts.ref) ?? opts.ref;
	const dir = snapshotDir(opts.appDir, id);
	if (!existsSync(resolve(dir, 'snapshot.json'))) {
		// Surface the available snapshots inline so the user doesn't have
		// to chase up a separate `snapshot list` invocation. Filter to the
		// requested stack so the list stays short on multi-stack apps.
		const available = await listSnapshots(opts.appDir);
		const sameStack = available.filter((e) => e.stack === opts.stack);
		const aliases = sameStack.map(
			(e) => `${e.id.slice(0, 12)}…${e.alias !== undefined ? ` (${e.alias})` : ''}`,
		);
		throw new Error(
			`loadSnapshot: no snapshot '${opts.ref}' for stack '${opts.stack}'\n` +
				`  Available: ${aliases.length > 0 ? aliases.join(', ') : '(none)'}`,
		);
	}
	const entry = readManifest(resolve(dir, 'snapshot.json'));
	const currentPlatform = `${process.platform}/${process.arch}`;
	if (entry.platform !== currentPlatform) {
		if (opts.forceArch !== true) {
			throw new Error(
				`loadSnapshot: snapshot platform '${entry.platform}' != current '${currentPlatform}'. ` +
					`Cross-arch restore can corrupt RocksDB; pass --force-arch to override.`,
			);
		}
		// --force-arch was passed; the operator explicitly opted into the
		// risk. Surface a loud warning before proceeding so a caller that
		// passed it reflexively (e.g. CI script copy-pasted from a working
		// same-arch run) sees the actual implication when this fires.
		process.stderr.write(
			`WARNING: cross-arch snapshot restore (${entry.platform} → ${currentPlatform}). ` +
				`RocksDB binary format may corrupt on first write — proceed with caution.\n`,
		);
	}

	const live = await listStackContainers(opts.appName, opts.stack);
	const liveInfos = await Promise.all(
		live.map(async (n) => ({ name: n, info: await inspectContainer(n) })),
	);
	const running = liveInfos
		.filter((entry) => entry.info?.running === true)
		.map((entry) => entry.name);
	if (running.length > 0) {
		throw new Error(
			`loadSnapshot: refusing to restore while containers are running: ${running.join(', ')}. ` +
				`Run \`devstack stack down\` first.`,
		);
	}

	// Re-tag each seed image to its original tag. This overwrites the
	// existing tag locally — the next `docker run --image=<originalImage>`
	// will pick up the seeded layer. If the seed image is absent locally
	// AND a registry tag was recorded at capture time, pull from the
	// registry first (CI / cross-host snapshot sharing path).
	for (const c of entry.containers) {
		let inspect = await dockerRun({
			command: ['image', 'inspect', c.seedImage, '--format', '{{.Id}}'],
		});
		if (inspect.code !== 0 && c.registryImage !== undefined) {
			process.stderr.write(`loadSnapshot: pulling ${c.registryImage}…\n`);
			const pull = await dockerRun({
				command: ['pull', c.registryImage],
				stream: true,
			});
			if (pull.code !== 0) {
				throw new Error(`loadSnapshot: docker pull ${c.registryImage} failed (exit ${pull.code}).`);
			}
			const reTag = await dockerRun({ command: ['tag', c.registryImage, c.seedImage] });
			if (reTag.code !== 0) {
				throw new Error(
					`loadSnapshot: docker tag ${c.registryImage} → ${c.seedImage} failed: ${reTag.stderr.trim()}`,
				);
			}
			inspect = await dockerRun({
				command: ['image', 'inspect', c.seedImage, '--format', '{{.Id}}'],
			});
		}
		if (inspect.code !== 0) {
			throw new Error(
				`loadSnapshot: seed image ${c.seedImage} not present locally and no registry tag recorded. ` +
					`Run \`devstack snapshot save\` again or pass --push to capture registry tags.`,
			);
		}
		const tag = await dockerRun({
			command: ['tag', c.seedImage, c.originalImage],
		});
		if (tag.code !== 0) {
			throw new Error(
				`loadSnapshot: docker tag ${c.seedImage} → ${c.originalImage} failed: ${tag.stderr.trim()}`,
			);
		}
	}

	// Replace <stackDir> from the bundle.
	const hostDst = stackDir(opts.appDir, opts.stack);
	const hostSrc = resolve(dir, 'host');
	if (existsSync(hostDst)) rmSync(hostDst, { recursive: true, force: true });
	mkdirSync(dirname(hostDst), { recursive: true });
	if (existsSync(hostSrc)) {
		cpSync(hostSrc, hostDst, { recursive: true });
	}

	return entry;
}

export async function listSnapshots(appDir: string): Promise<SnapshotEntry[]> {
	const root = snapshotsRoot(appDir);
	if (!existsSync(root)) return [];
	const out: SnapshotEntry[] = [];
	const aliasMap = readAliases(appDir);
	for (const entry of readdirSync(root)) {
		if (entry === 'aliases') continue;
		const sub = resolve(root, entry);
		const manifest = resolve(sub, 'snapshot.json');
		if (!existsSync(manifest)) continue;
		const parsed = readManifest(manifest);
		// Surface the alias if any name resolves to this id.
		const alias = aliasMap.get(parsed.id);
		out.push({ ...parsed, alias: alias ?? parsed.alias });
	}
	out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return out;
}

export async function removeSnapshot(opts: { appDir: string; ref: string }): Promise<boolean> {
	const id = resolveAlias(opts.appDir, opts.ref) ?? opts.ref;
	const dir = snapshotDir(opts.appDir, id);
	if (!existsSync(dir)) return false;
	const manifest = resolve(dir, 'snapshot.json');
	if (existsSync(manifest)) {
		const entry = readManifest(manifest);
		// Best-effort clean up of seed images.
		for (const c of entry.containers) {
			await dockerRun({ command: ['image', 'rm', '-f', c.seedImage] }).catch(() => undefined);
		}
	}
	rmSync(dir, { recursive: true, force: true });
	// Remove any alias symlinks that pointed here.
	const aliases = aliasDir(opts.appDir);
	if (existsSync(aliases)) {
		for (const name of readdirSync(aliases)) {
			const link = resolve(aliases, name);
			try {
				const target = readSymlinkTarget(link);
				if (target !== null && target.endsWith(`/${id}`)) {
					unlinkSync(link);
				}
			} catch {
				/* skip broken */
			}
		}
	}
	return true;
}

async function readContainerLabels(name: string): Promise<Record<string, string>> {
	const result = await dockerRun({
		command: ['container', 'inspect', name, '--format', '{{json .Config.Labels}}'],
	});
	if (result.code !== 0) return {};
	try {
		return JSON.parse(result.stdout.trim()) as Record<string, string>;
	} catch {
		return {};
	}
}

function parseCommit(labels: Record<string, string>): boolean {
	const raw = labels['devstack.snapshot.commit'];
	if (raw === undefined) return true; // default for Service containers
	return raw === 'true';
}

function parseQuiesce(labels: Record<string, string>): 'pause' | 'stop' | 'none' {
	const raw = labels['devstack.snapshot.quiesce'];
	if (raw === 'pause' || raw === 'stop' || raw === 'none') return raw;
	return 'stop'; // safe default
}

async function pauseContainer(name: string): Promise<void> {
	const result = await dockerRun({ command: ['pause', name] });
	if (result.code !== 0) {
		throw new Error(`pauseContainer: docker pause ${name} failed: ${result.stderr.trim()}`);
	}
}

async function unpauseContainer(name: string): Promise<void> {
	const result = await dockerRun({ command: ['unpause', name] });
	if (result.code !== 0) {
		throw new Error(`unpauseContainer: docker unpause ${name} failed: ${result.stderr.trim()}`);
	}
}

async function listStackContainers(appName: string, stack: string): Promise<string[]> {
	const result = await dockerRun({
		command: [
			'ps',
			'-a',
			'--format',
			'{{.Names}}',
			'--filter',
			`label=devstack.app=${appName}`,
			'--filter',
			`label=devstack.stack=${stack}`,
		],
	});
	if (result.code !== 0) return [];
	return result.stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function writeManifestAtomic(path: string, entry: SnapshotEntry): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
	renameSync(tmp, path);
}

function readManifest(path: string): SnapshotEntry {
	const raw = readFileSync(path, 'utf8');
	return JSON.parse(raw) as SnapshotEntry;
}

function writeAlias(appDir: string, alias: string, id: string): void {
	const dir = aliasDir(appDir);
	mkdirSync(dir, { recursive: true });
	const link = aliasPath(appDir, alias);
	if (existsSync(link)) unlinkSync(link);
	// Relative symlink so the snapshots dir is portable across moves.
	symlinkSync(`../${id}`, link);
}

function resolveAlias(appDir: string, ref: string): string | null {
	const link = aliasPath(appDir, ref);
	if (!existsSync(link)) return null;
	const target = readSymlinkTarget(link);
	if (target === null) return null;
	// Symlinks store `../sha-id`; strip the prefix.
	const m = target.match(/^(?:\.\.\/)?(.+)$/);
	return m?.[1] ?? null;
}

function readAliases(appDir: string): Map<string, string> {
	const out = new Map<string, string>();
	const dir = aliasDir(appDir);
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const link = resolve(dir, name);
		try {
			const target = readSymlinkTarget(link);
			if (target === null) continue;
			const m = target.match(/^(?:\.\.\/)?(.+)$/);
			const id = m?.[1];
			if (id !== undefined) out.set(id, name);
		} catch {
			/* skip */
		}
	}
	return out;
}

function readSymlinkTarget(path: string): string | null {
	try {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat === undefined || !stat.isSymbolicLink()) return null;
		return readlinkSync(path);
	} catch {
		return null;
	}
}

/** Convenience: derive a snapshot id from a DevstackConfig + active stack
 * + platform. Used by the CLI `snapshot id` subcommand and by future
 * cache lookups. Each plugin's `inputs` field is folded into the hash
 * so bumping `rev:` on walrus / seal / deepbook, switching the sui
 * image tag, or editing a `use:` setup action invalidates the cached
 * snapshot id automatically. */
export function snapshotIdFromConfig(input: {
	appName: string;
	stack: string;
	plugins: ReadonlyArray<{ name: string; version?: string; inputs?: unknown }>;
	accountNames: string[];
	suiImage?: string;
}): string {
	return computeSnapshotId({
		appName: input.appName,
		stack: input.stack,
		platform: `${process.platform}/${process.arch}`,
		plugins: input.plugins,
		accountNames: input.accountNames,
		suiImage: input.suiImage,
	});
}
