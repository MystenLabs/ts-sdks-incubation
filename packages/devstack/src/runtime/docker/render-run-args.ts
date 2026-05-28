// `docker run` / `docker create` argv assembly.
//
// `dockerRunOneShot` (one-shot `docker run --rm`) and `freshCreate`
// (long-lived `docker run -d` from `container.ts`) both flatten a
// structured spec into the same repeating argv patterns —
// `--env K=V`, `--mount type=bind,...`, `--add-host h:ip`, etc. The
// flag order differs between the two consumers and that order is
// load-bearing for byte-identical migration (tests assert exact
// argv strings), so this module exposes:
//
//   - `renderRunArgs` — argv shape used by `dockerRunOneShot`.
//   - `renderCreateArgs` — argv shape used by `freshCreate`.
//
// Both share the internal per-flag emit helpers so the repeated
// patterns live in one place. New Docker-run-style call sites should
// pick whichever helper matches the order they want (or extend this
// module rather than open-coding `args.push('--env', ...)` again).

// -----------------------------------------------------------------------------
// Shared flag shapes
// -----------------------------------------------------------------------------

/** `--mount type=bind,source=...,target=...[,readonly]`. */
export interface BindMountSpec {
	readonly source: string;
	readonly target: string;
	readonly readonly?: boolean;
}

/** `-p [hostIp:]hostPort:containerPort`. Mirrors `ContainerPortPublish`
 *  but kept independent so this module has no upward dep on
 *  `contracts/`. */
export interface PortPublishSpec {
	readonly containerPort: number;
	readonly hostPort: number;
	readonly hostIp?: string;
}

/** First-network attachment + optional per-network DNS aliases. */
export interface NetworkAttachSpec {
	readonly name: string;
	readonly aliases?: ReadonlyArray<string>;
}

// -----------------------------------------------------------------------------
// Per-flag emit helpers — internal
// -----------------------------------------------------------------------------

const pushEnv = (args: Array<string>, env: Readonly<Record<string, string>> | undefined): void => {
	if (env === undefined) return;
	for (const [k, v] of Object.entries(env)) {
		args.push('--env', `${k}=${v}`);
	}
};

const pushMounts = (
	args: Array<string>,
	mounts: ReadonlyArray<BindMountSpec> | undefined,
): void => {
	if (mounts === undefined) return;
	for (const m of mounts) {
		const ro = m.readonly ? ',readonly' : '';
		args.push('--mount', `type=bind,source=${m.source},target=${m.target}${ro}`);
	}
};

const pushAddHosts = (
	args: Array<string>,
	addHosts: Readonly<Record<string, string>> | undefined,
): void => {
	if (addHosts === undefined) return;
	for (const [host, ip] of Object.entries(addHosts)) {
		args.push('--add-host', `${host}:${ip}`);
	}
};

const pushLabels = (args: Array<string>, labels: ReadonlyArray<string> | undefined): void => {
	if (labels === undefined) return;
	for (const l of labels) args.push('--label', l);
};

const pushPorts = (
	args: Array<string>,
	ports: ReadonlyArray<PortPublishSpec> | undefined,
): void => {
	if (ports === undefined) return;
	for (const p of ports) {
		const hostPrefix = p.hostIp === undefined ? '' : `${p.hostIp}:`;
		args.push('-p', `${hostPrefix}${p.hostPort}:${p.containerPort}`);
	}
};

// -----------------------------------------------------------------------------
// `renderRunArgs` — one-shot `docker run --rm`
// -----------------------------------------------------------------------------

/** Spec for `renderRunArgs`. Mirrors what `dockerRunOneShot` already
 *  flattens. Order of the resulting argv is fixed by `renderRunArgs`. */
export interface RenderRunArgsSpec {
	/** Drop `--rm` when true (forensic-retention escape hatch). */
	readonly keep?: boolean;
	readonly name: string;
	readonly image: string;
	/** Positional argv appended after the image. */
	readonly argv?: ReadonlyArray<string>;
	readonly network?: string;
	readonly entrypoint?: string;
	readonly user?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly mounts?: ReadonlyArray<BindMountSpec>;
	/** Pre-rendered `key=value` strings. */
	readonly labels?: ReadonlyArray<string>;
	readonly addHosts?: Readonly<Record<string, string>>;
}

/** Render argv for `docker run --rm`-style one-shot invocations.
 *
 *  Output order:
 *    `[--rm?] --name N [--network …] [--entrypoint …] [--user …]
 *     env… mount… label… add-host… <image> [argv…]`
 *
 *  Order is load-bearing — callers' fake-docker tests assert against
 *  this exact sequence. */
export const renderRunArgs = (spec: RenderRunArgsSpec): ReadonlyArray<string> => {
	const args: Array<string> = [];
	if (!spec.keep) args.push('--rm');
	args.push('--name', spec.name);
	if (spec.network) args.push('--network', spec.network);
	if (spec.entrypoint) args.push('--entrypoint', spec.entrypoint);
	if (spec.user) args.push('--user', spec.user);
	pushEnv(args, spec.env);
	pushMounts(args, spec.mounts);
	pushLabels(args, spec.labels);
	pushAddHosts(args, spec.addHosts);
	args.push(spec.image);
	if (spec.argv) args.push(...spec.argv);
	return args;
};

// -----------------------------------------------------------------------------
// `renderCreateArgs` — long-lived `docker run -d`
// -----------------------------------------------------------------------------

/** Spec for `renderCreateArgs`. Used by `freshCreate` in
 *  `container.ts`. Long-lived containers always run detached. */
export interface RenderCreateArgsSpec {
	readonly name: string;
	readonly image: string;
	/** Positional argv appended after the image. */
	readonly command?: ReadonlyArray<string>;
	/** First network attach — emitted via `--network`. Per-network
	 *  aliases become `--network-alias` flags. Secondary attaches are
	 *  done post-start by the caller (architecture §5). */
	readonly network?: NetworkAttachSpec;
	readonly entrypoint?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly mounts?: ReadonlyArray<BindMountSpec>;
	readonly ports?: ReadonlyArray<PortPublishSpec>;
	/** Pre-rendered `key=value` strings (typically from `renderContainerLabels`). */
	readonly labels?: ReadonlyArray<string>;
	readonly addHosts?: Readonly<Record<string, string>>;
}

/** Render argv for `docker run -d`-style long-lived container create.
 *
 *  Output order:
 *    `-d --name N label… env… -p… mount… [--network N --network-alias …]
 *     add-host… [--entrypoint …] <image> [command…]`
 *
 *  Order is load-bearing — tests that snapshot the create argv assert
 *  against this exact sequence. */
export const renderCreateArgs = (spec: RenderCreateArgsSpec): ReadonlyArray<string> => {
	const args: Array<string> = ['-d', '--name', spec.name];
	pushLabels(args, spec.labels);
	pushEnv(args, spec.env);
	pushPorts(args, spec.ports);
	pushMounts(args, spec.mounts);
	if (spec.network !== undefined) {
		args.push('--network', spec.network.name);
		for (const alias of spec.network.aliases ?? []) {
			args.push('--network-alias', alias);
		}
	}
	pushAddHosts(args, spec.addHosts);
	if (spec.entrypoint) args.push('--entrypoint', spec.entrypoint);
	args.push(spec.image);
	if (spec.command) args.push(...spec.command);
	return args;
};
