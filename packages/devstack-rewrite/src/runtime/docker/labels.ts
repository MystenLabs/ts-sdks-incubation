// Docker label contract.
//
// Architecture § Container runtime § Label-driven inventory:
//   Containers, images, networks, and volumes are enumerated by the
//   four canonical engine-level dimensions and a small set of
//   well-known role labels. Inventory NEVER greps stdout for names.
//
// The four canonical engine dimensions (no service names anywhere):
//
//   - `devstack.app`     — the app/project this resource belongs to
//   - `devstack.stack`   — the stack name within that app
//   - `devstack.plugin`  — the plugin key (opaque to the runtime)
//   - `devstack.role`    — the resource's role within the plugin (also opaque)
//
// Plus two protocol-level labels for the lifecycle machinery:
//
//   - `devstack.cycle`   — the engine cycle id that last touched it
//                          (sweep filters by this to find orphans)
//   - `devstack.managed` — set to `'true'` on every resource we own;
//                          a coarse "is this ours at all?" filter
//
// Network / image / volume specializations carry only the canonical
// engine dimensions plus a kind-specific marker.

import type { ContainerLabelTuple } from '../../contracts/snapshotable.ts';

/** Canonical label keys. Single source of truth. */
export const LabelKey = {
	app: 'devstack.app',
	stack: 'devstack.stack',
	plugin: 'devstack.plugin',
	role: 'devstack.role',
	cycle: 'devstack.cycle',
	managed: 'devstack.managed',
	// Resource-kind markers — coarse "what is this?" classification
	// for inventory walks.
	networkMarker: 'devstack.network',
	volumeMarker: 'devstack.volume',
	// Reverse-proxy / routable. Router itself is built outside this
	// package, but if it stamps a label, this is the key it uses.
	routerMarker: 'devstack.router',
} as const;

export type LabelKey = (typeof LabelKey)[keyof typeof LabelKey];

/** Docker Compose-compatible labels used only for Docker Desktop grouping.
 *  Cleanup and inventory remain keyed by `LabelKey` above. */
export const ComposeLabelKey = {
	project: 'com.docker.compose.project',
	service: 'com.docker.compose.service',
	containerNumber: 'com.docker.compose.container-number',
	version: 'com.docker.compose.version',
	oneoff: 'com.docker.compose.oneoff',
	network: 'com.docker.compose.network',
	volume: 'com.docker.compose.volume',
} as const;

export type ComposeLabelKey = (typeof ComposeLabelKey)[keyof typeof ComposeLabelKey];

export const COMPOSE_UI_VERSION = '2.0.0';

const normalizeComposeSegment = (value: string): string => {
	const normalized = value
		.trim()
		.replace(/[^a-zA-Z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized.length > 0 ? normalized : 'unnamed';
};

export const composeProjectId = (app: string, stack: string): string =>
	`${normalizeComposeSegment(app)}-${normalizeComposeSegment(stack)}`;

export const composeServiceId = (tuple: ContainerLabelTuple): string =>
	`${normalizeComposeSegment(tuple.plugin)}.${normalizeComposeSegment(tuple.role)}`;

export const renderComposeContainerLabels = (tuple: ContainerLabelTuple): ReadonlyArray<string> => [
	`${ComposeLabelKey.project}=${composeProjectId(tuple.app, tuple.stack)}`,
	`${ComposeLabelKey.service}=${composeServiceId(tuple)}`,
	`${ComposeLabelKey.containerNumber}=1`,
	`${ComposeLabelKey.version}=${COMPOSE_UI_VERSION}`,
	`${ComposeLabelKey.oneoff}=False`,
];

export const renderComposeNetworkLabels = (
	name: string,
	app: string,
	stack: string,
): ReadonlyArray<string> => [
	`${ComposeLabelKey.project}=${composeProjectId(app, stack)}`,
	`${ComposeLabelKey.network}=${name}`,
	`${ComposeLabelKey.version}=${COMPOSE_UI_VERSION}`,
];

export const renderComposeVolumeLabels = (
	name: string,
	tuple: ContainerLabelTuple,
): ReadonlyArray<string> => [
	`${ComposeLabelKey.project}=${composeProjectId(tuple.app, tuple.stack)}`,
	`${ComposeLabelKey.volume}=${name}`,
	`${ComposeLabelKey.version}=${COMPOSE_UI_VERSION}`,
];

/** Render a `ContainerLabelTuple` to docker `--label key=value` pairs.
 *  The cycle/managed labels are stamped at create time by `container.ts`. */
export const renderContainerLabels = (
	tuple: ContainerLabelTuple,
	cycle: number,
): ReadonlyArray<string> => {
	const ownership = [
		`${LabelKey.managed}=true`,
		`${LabelKey.app}=${tuple.app}`,
		`${LabelKey.stack}=${tuple.stack}`,
		`${LabelKey.plugin}=${tuple.plugin}`,
		`${LabelKey.role}=${tuple.role}`,
		`${LabelKey.cycle}=${cycle}`,
	];
	return [...ownership, ...renderComposeContainerLabels(tuple)];
};

/** Render a label-tuple as `--filter label=key=value` args for `docker ps`,
 *  `docker volume ls`, etc. Partial tuples allowed (sweep / inventory). */
export const renderFilterArgs = (
	match: Partial<ContainerLabelTuple>,
	extra: Readonly<Record<string, string>> = {},
): ReadonlyArray<string> => {
	const filters: Array<string> = [`label=${LabelKey.managed}=true`];
	if (match.app !== undefined) filters.push(`label=${LabelKey.app}=${match.app}`);
	if (match.stack !== undefined) filters.push(`label=${LabelKey.stack}=${match.stack}`);
	if (match.plugin !== undefined) filters.push(`label=${LabelKey.plugin}=${match.plugin}`);
	if (match.role !== undefined) filters.push(`label=${LabelKey.role}=${match.role}`);
	for (const [k, v] of Object.entries(extra)) filters.push(`label=${k}=${v}`);
	return filters.flatMap((f) => ['--filter', f]);
};

/** Network-specific labels (shared `devstack` network is cross-stack;
 *  per-stack networks would stamp the full tuple). */
export const renderNetworkLabels = (
	name: string,
	app: string,
	stack: string,
	opts: { readonly composeUi?: boolean } = {},
): ReadonlyArray<string> => {
	const ownership = [
		`${LabelKey.managed}=true`,
		`${LabelKey.networkMarker}=true`,
		`${LabelKey.app}=${app}`,
		`${LabelKey.stack}=${stack}`,
	];
	return opts.composeUi === false
		? ownership
		: [...ownership, ...renderComposeNetworkLabels(name, app, stack)];
};

/** Volume labels — pre-create with these before any `run -v` argv to
 *  avoid docker's lazy unlabelled-create. */
export const renderVolumeLabels = (
	name: string,
	tuple: ContainerLabelTuple,
): ReadonlyArray<string> => {
	const ownership = [
		`${LabelKey.managed}=true`,
		`${LabelKey.volumeMarker}=true`,
		`${LabelKey.app}=${tuple.app}`,
		`${LabelKey.stack}=${tuple.stack}`,
		`${LabelKey.plugin}=${tuple.plugin}`,
		`${LabelKey.role}=${tuple.role}`,
	];
	return [...ownership, ...renderComposeVolumeLabels(name, tuple)];
};
