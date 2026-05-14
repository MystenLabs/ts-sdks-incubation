import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Dep, Env, Provides, ResolvedDeps } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';

const exec = promisify(execFile);

export interface DockerOneShotVolumeMapping {
	host: string;
	container: string;
	/** `'ro'` mounts the host path read-only inside the container. */
	mode?: 'ro' | 'rw';
}

export interface DockerOneShotResolveArgs<TDeps> {
	env: Env;
	deps: ResolvedDeps<TDeps>;
}

export type DockerOneShotValue<T, TDeps> =
	| T
	| ((args: DockerOneShotResolveArgs<TDeps>) => T);

export interface DockerOneShotState {
	containerName: string;
	image: string;
	args: string[];
	exitCode: number;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	/** Last ~32 KB of combined stdout+stderr captured for diagnostics. */
	tail: string;
	/** Engine `inputHash` at the time the container ran. Used to bail
	 * out of `start` early when nothing about the spawn would change —
	 * one-shots should NOT re-run on stable inputs (think keygen, where
	 * a fresh run produces fresh keys and silently invalidates anything
	 * that captured the prior public key). */
	inputHash: string;
}

export interface DockerOneShotConfig<TDeps> {
	name: string;
	deps?: TDeps;

	/** Image tag (literal) or `Dep<string>` chained off a
	 * `dockerImage(...)` producer. Mirrors `dockerContainer.image`. */
	image: string | Dep<string>;

	/** Container command — `args` after the image in `docker run`. May
	 * read upstream deps. */
	args?: DockerOneShotValue<string[], TDeps>;
	/** Optional `--entrypoint <bin>` override (e.g. running `seal-cli`
	 * against an image whose default ENTRYPOINT is `key-server`). Static
	 * string only — folds into the input hash via the inputs callback. */
	entrypoint?: string;
	containerEnv?: DockerOneShotValue<Record<string, string>, TDeps>;
	volumes?: DockerOneShotValue<DockerOneShotVolumeMapping[], TDeps>;

	/** Optional `--network <name>`. Literal string or `Dep<string>`
	 * chained off the standard `dockerNetwork` node so the per-(app,
	 * stack) bridge identity flows in. Same shape as
	 * `dockerContainer.network`. */
	network?: string | Dep<string>;
	/** Optional `--network-alias <alias>` — DNS name siblings on the
	 * same network use to reach this container. Ignored unless
	 * `network` is set. */
	networkAlias?: string;
	/** Optional `--ip <addr>` — fixed IP within the network's subnet.
	 * Ignored unless `network` is set. */
	ip?: string;
	/** Optional `--hostname <name>` for in-network DNS. */
	hostname?: DockerOneShotValue<string, TDeps>;
	/** Optional `--platform <os/arch>`. */
	platform?: string;
	/** Optional `--name <name>` override. Default: `cfg.name` literally
	 * (which is also the producer name). The runner removes a stale
	 * container with the same name before the run so a prior failure
	 * doesn't trip on the next attempt. */
	containerName?: DockerOneShotValue<string, TDeps>;

	/** Hard ceiling on the container's run duration. Default 10 minutes.
	 * The runner SIGTERMs and removes the container on timeout, then
	 * throws. */
	timeoutMs?: number;

	/** Forwarded to define for input-hash material. */
	inputs?: (args: DockerOneShotResolveArgs<TDeps>) => unknown | Promise<unknown>;
}

const oneShotProvides = {
	state: dep((s: DockerOneShotState) => s),
	full: dep((s: DockerOneShotState) => s),
} satisfies Provides<DockerOneShotState>;

// `dockerOneShot` runs a container to completion and resolves with the
// exit code + combined-output tail. Use for deploy scripts, init jobs,
// and other run-once workloads where the container exits when done.
//
// Like `dockerContainer`, the container appears as a first-class graph
// node so plugins compose this rather than calling `docker run` from
// `start`. The image can be a literal tag or a `Dep<string>`
// chained off `dockerImage(...)` — bumping the image's identity
// (build-arg, Dockerfile, context) flips this node's input hash and
// re-runs the container with the new tag.
//
// The runner does NOT manage host volumes' contents — the caller
// supplies the host paths in `volumes:`; the runner only mounts them.
// Outputs the container writes to a host bind survive the container's
// removal and are the way downstream transformers (e.g. walrus.deploy
// reading the parsed deploy file) consume the result.
//
// Re-run semantics: the engine's input-hash machinery decides whether
// to re-run on each cycle. Stable inputs (image, args, env, volumes,
// deps) → skip. An invalidate or upstream cascade re-fires the
// container. Non-zero exit aborts the cycle (the engine surfaces the
// error normally).
export function dockerOneShot<TDeps = undefined>(cfg: DockerOneShotConfig<TDeps>) {
	if (!cfg.name) throw new Error('dockerOneShot: `name` is required');
	if (cfg.image === undefined || cfg.image === null) {
		throw new Error(`dockerOneShot("${cfg.name}"): \`image\` is required`);
	}
	if (typeof cfg.image === 'string' && cfg.image.length === 0) {
		throw new Error(`dockerOneShot("${cfg.name}"): \`image\` is required`);
	}
	const timeoutMs = cfg.timeoutMs ?? 10 * 60_000;

	const imageIsDep = isDep(cfg.image);
	const networkIsDep = cfg.network !== undefined && isDep(cfg.network);
	const internalDeps: {
		user: TDeps;
		_image?: Dep<string>;
		_network?: Dep<string>;
	} = {
		user: cfg.deps as TDeps,
	};
	if (imageIsDep) {
		internalDeps._image = cfg.image as Dep<string>;
	}
	if (networkIsDep) {
		internalDeps._network = cfg.network as Dep<string>;
	}

	return define<DockerOneShotState, typeof oneShotProvides>({
		name: cfg.name,
		deps: internalDeps,
		provides: oneShotProvides,
		...(cfg.inputs
			? {
					inputs: (args) => {
						const resolved = args.deps as unknown as { user: ResolvedDeps<TDeps> };
						return cfg.inputs!({ env: args.env, deps: resolved.user });
					},
				}
			: {}),

		start: async ({ env, deps, log, prior, inputHash }) => {
			// One-shots don't re-run on stable inputs. The engine fires
			// `start` every cycle (because `hasStart`), so the bail-early
			// logic lives here: if the prior run's `inputHash` matches,
			// reuse its state. The engine still recomputes `inputHash`
			// from upstream identities + ownInputs, so a Dockerfile bump,
			// arg change, env tweak, or upstream image rebuild flips the
			// hash and we re-run.
			if (prior && prior.inputHash === inputHash) {
				log(`reusing prior one-shot result (inputs unchanged, exit ${prior.exitCode})`);
				return prior;
			}
			const resolved = deps as unknown as {
				user: ResolvedDeps<TDeps>;
				_image?: string;
				_network?: string;
			};
			const resolveCtx = { env, deps: resolved.user };

			const containerArgs = resolveValue(cfg.args, resolveCtx) ?? [];
			const containerEnv = resolveValue(cfg.containerEnv, resolveCtx) ?? {};
			const volumes = resolveValue(cfg.volumes, resolveCtx) ?? [];
			const network = networkIsDep
				? (resolved._network as string)
				: (cfg.network as string | undefined);
			if (network !== undefined && (typeof network !== 'string' || network.length === 0)) {
				throw new Error(
					`dockerOneShot("${cfg.name}"): network dep resolved to empty/non-string value`,
				);
			}
			const hostname = resolveValue(cfg.hostname, resolveCtx);
			const stack = env.stack ?? 'main';
			// Docker `--name` rejects leading non-alphanumeric chars, so
			// strip them (e.g. `_template` → `template-…`).
			const containerName =
				resolveValue(cfg.containerName, resolveCtx) ??
				`${env.appName}-${stack}-${cfg.name}`.replace(/^[^a-zA-Z0-9]+/, '');
			const image = imageIsDep ? (resolved._image as string) : (cfg.image as string);
			if (typeof image !== 'string' || image.length === 0) {
				throw new Error(
					`dockerOneShot("${cfg.name}"): image dep resolved to empty/non-string value`,
				);
			}

			// Drop a stale container with the same name from a prior
			// failed run, so `docker run --name` doesn't conflict.
			await dockerRm(containerName).catch(() => undefined);

			const labels: Record<string, string> = {
				'devstack.app': env.appName,
				'devstack.action': cfg.name,
			};
			if (env.stack !== undefined) labels['devstack.stack'] = env.stack;
			const runArgs = buildDockerRunArgs({
				containerName,
				image,
				args: containerArgs,
				containerEnv,
				volumes,
				labels,
				...(network !== undefined ? { network } : {}),
				...(cfg.networkAlias !== undefined ? { networkAlias: cfg.networkAlias } : {}),
				...(cfg.ip !== undefined ? { ip: cfg.ip } : {}),
				...(hostname !== undefined ? { hostname } : {}),
				...(cfg.platform !== undefined ? { platform: cfg.platform } : {}),
				...(cfg.entrypoint !== undefined ? { entrypoint: cfg.entrypoint } : {}),
			});

			log(`docker run ${runArgs.join(' ')}`);
			const startedAt = Date.now();
			const result = await runWithTimeout('docker', runArgs, timeoutMs);
			const finishedAt = Date.now();

			if (result.timedOut) {
				await dockerRm(containerName).catch(() => undefined);
				throw new Error(
					`dockerOneShot("${cfg.name}"): timed out after ${timeoutMs}ms; ` +
						'last output:\n' +
						result.tail,
				);
			}
			if (result.exitCode !== 0) {
				throw new Error(
					`dockerOneShot("${cfg.name}"): exited with code ${result.exitCode}; ` +
						'last output:\n' +
						result.tail,
				);
			}

			return {
				containerName,
				image,
				args: containerArgs,
				exitCode: 0,
				startedAt,
				finishedAt,
				durationMs: finishedAt - startedAt,
				tail: result.tail,
				inputHash,
			};
		},
	});
}

function isDep(value: unknown): value is Dep<string> {
	if (typeof value !== 'object' || value === null) return false;
	return '__producer' in value || '__pluginId' in value;
}

function buildDockerRunArgs(opts: {
	containerName: string;
	image: string;
	args: string[];
	containerEnv: Record<string, string>;
	volumes: DockerOneShotVolumeMapping[];
	labels: Record<string, string>;
	network?: string;
	networkAlias?: string;
	ip?: string;
	hostname?: string;
	platform?: string;
	entrypoint?: string;
}): string[] {
	// `--rm` so the auto-removal handles cleanup; otherwise the next run
	// would collide on the same name even after dockerRm above.
	const args = ['run', '--rm', '--name', opts.containerName];
	if (opts.platform !== undefined) args.push('--platform', opts.platform);
	if (opts.entrypoint !== undefined) args.push('--entrypoint', opts.entrypoint);
	if (opts.network !== undefined) {
		args.push('--network', opts.network);
		if (opts.networkAlias !== undefined) args.push('--network-alias', opts.networkAlias);
		if (opts.ip !== undefined) args.push('--ip', opts.ip);
	}
	if (opts.hostname !== undefined) args.push('--hostname', opts.hostname);
	for (const [k, v] of Object.entries(opts.containerEnv)) {
		args.push('-e', `${k}=${v}`);
	}
	for (const v of opts.volumes) {
		const suffix = v.mode === 'ro' ? ':ro' : '';
		args.push('-v', `${v.host}:${v.container}${suffix}`);
	}
	for (const [k, v] of Object.entries(opts.labels)) {
		args.push('--label', `${k}=${v}`);
	}
	args.push(opts.image, ...opts.args);
	return args;
}

interface RunResult {
	exitCode: number;
	timedOut: boolean;
	tail: string;
}

const TAIL_LIMIT = 32 * 1024;

// Spawn `docker run` in the foreground, collect combined stdout+stderr,
// and resolve when the child exits. SIGTERMs the child on timeout (then
// SIGKILLs after a short grace) so a hung container doesn't wedge the
// engine cycle. Output is capped at TAIL_LIMIT bytes — beyond that we
// only keep the trailing window for diagnostics.
async function runWithTimeout(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<RunResult> {
	const { spawn } = await import('node:child_process');
	return new Promise<RunResult>((resolve) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const buffers: Buffer[] = [];
		let total = 0;
		const onData = (b: Buffer) => {
			buffers.push(b);
			total += b.length;
			while (total > TAIL_LIMIT && buffers.length > 1) {
				const head = buffers.shift();
				if (head) total -= head.length;
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
		}, timeoutMs);
		timer.unref();

		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			const tail = Buffer.concat(buffers).toString('utf8').slice(-TAIL_LIMIT);
			resolve({
				exitCode: code ?? (signal !== null ? 128 : -1),
				timedOut,
				tail,
			});
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			const tail = `${Buffer.concat(buffers).toString('utf8')}\nspawn error: ${err.message}`.slice(-TAIL_LIMIT);
			resolve({ exitCode: -1, timedOut: false, tail });
		});
	});
}

async function dockerRm(containerName: string): Promise<void> {
	await exec('docker', ['rm', '-f', containerName]);
}

function resolveValue<T, TDeps>(
	v: DockerOneShotValue<T, TDeps> | undefined,
	args: DockerOneShotResolveArgs<TDeps>,
): T | undefined {
	if (typeof v === 'function') {
		return (v as (a: DockerOneShotResolveArgs<TDeps>) => T)(args);
	}
	return v;
}
