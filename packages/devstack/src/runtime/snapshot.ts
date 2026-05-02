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

import { dockerRun, inspectContainer, startContainer, stopContainer } from '../plugins/sui/docker.js';
import { stableHash } from './hash.js';
import { stackDir } from './active-stack.js';

export interface SnapshotContainerEntry {
	/** Container name as it existed at capture time (e.g.,
	 * `token-studio-main-sui`). Restore re-creates the container under
	 * this name on the next `devstack up`. */
	containerName: string;
	/** Image tag the container was originally created from (e.g.,
	 * `dev-examples/sui-localnet:devnet-v1.71.0-r7`). Restore re-tags
	 * `seedImage` to this so the plugin's `docker run` from its
	 * hardcoded tag picks up the seeded layer. */
	originalImage: string;
	/** Image tag we committed the container into (e.g.,
	 * `devstack-snapshot/<sha-id>/token-studio-main-sui:seeded`). Lives
	 * in the local docker daemon's image store. */
	seedImage: string;
}

export interface SnapshotEntry {
	id: string;
	alias?: string;
	createdAt: string;
	platform: string;
	stack: string;
	appName: string;
	containers: SnapshotContainerEntry[];
}

export interface SnapshotIdInput {
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

export interface CaptureOptions {
	appName: string;
	appDir: string;
	stack: string;
	id: string;
	alias?: string;
	/** Containers labeled with this stack get committed. Defaults to
	 * label-based discovery via `dockerRun(['ps', '-a', '--filter',
	 * 'label=devstack.app=<a>', '--filter', 'label=devstack.stack=<s>'])`. */
	containerNames?: string[];
}

/** Capture the current state of a stack as a snapshot. For each labeled
 * container: read its `devstack.snapshot.*` labels for per-container
 * commit/quiesce policy, quiesce per the policy, `docker commit` (when
 * commit=true), then restart. Copies `<stackDir>` into the bundle.
 *
 * Per-container defaults when labels are absent (e.g., legacy containers
 * created before PR 4): commit=true, quiesce='stop'. */
export async function captureSnapshot(opts: CaptureOptions): Promise<SnapshotEntry> {
	const containerNames = opts.containerNames ?? (await listStackContainers(opts.appName, opts.stack));
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
		containers.push({
			containerName: entry.name,
			originalImage: entry.info.image,
			seedImage,
		});
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

	const dir = snapshotDir(opts.appDir, opts.id);
	mkdirSync(dir, { recursive: true });
	const hostSrc = stackDir(opts.appDir, opts.stack);
	const hostDst = resolve(dir, 'host');
	if (existsSync(hostDst)) rmSync(hostDst, { recursive: true, force: true });
	if (existsSync(hostSrc)) {
		cpSync(hostSrc, hostDst, { recursive: true });
	} else {
		mkdirSync(hostDst, { recursive: true });
	}

	const entry: SnapshotEntry = {
		id: opts.id,
		alias: opts.alias,
		createdAt: new Date().toISOString(),
		platform: `${process.platform}/${process.arch}`,
		stack: opts.stack,
		appName: opts.appName,
		containers,
	};
	writeManifestAtomic(resolve(dir, 'snapshot.json'), entry);

	if (opts.alias !== undefined) {
		writeAlias(opts.appDir, opts.alias, opts.id);
	}

	return entry;
}

export interface RestoreOptions {
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
		throw new Error(`loadSnapshot: no snapshot at ${dir} (ref='${opts.ref}')`);
	}
	const entry = readManifest(resolve(dir, 'snapshot.json'));
	const currentPlatform = `${process.platform}/${process.arch}`;
	if (entry.platform !== currentPlatform && opts.forceArch !== true) {
		throw new Error(
			`loadSnapshot: snapshot platform '${entry.platform}' != current '${currentPlatform}'. ` +
				`Cross-arch restore can corrupt RocksDB; pass --force-arch to override.`,
		);
	}

	const live = await listStackContainers(opts.appName, opts.stack);
	const liveInfos = await Promise.all(live.map(async (n) => ({ name: n, info: await inspectContainer(n) })));
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
	// will pick up the seeded layer. Verify each seed image is present
	// first; if missing, the snapshot is unusable on this machine.
	for (const c of entry.containers) {
		const inspect = await dockerRun({
			command: ['image', 'inspect', c.seedImage, '--format', '{{.Id}}'],
		});
		if (inspect.code !== 0) {
			throw new Error(
				`loadSnapshot: seed image ${c.seedImage} not present locally. ` +
					`Run \`devstack snapshot save\` again or pull from registry.`,
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
 * + platform. Used by the CLI `snapshot hash` subcommand and by future
 * cache lookups. */
export function snapshotIdFromConfig(input: {
	appName: string;
	stack: string;
	plugins: ReadonlyArray<{ name: string; version?: string }>;
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

// Helper exported for tests: get the snapshot directory for an id.
export function snapshotDirFor(appDir: string, id: string): string {
	return snapshotDir(appDir, id);
}
