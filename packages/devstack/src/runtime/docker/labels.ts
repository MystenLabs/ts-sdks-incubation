// Docker label conventions used by the devstack to filter resources by
// app/stack/service. The CLI's `stack list / down / wipe` and
// `snapshot save` paths filter by these.

/** Image-tag namespace stamped on devstack-built docker images. */
export const DEVSTACK_IMAGE_NAMESPACE = 'mysten-devstack';

/**
 * Container labels devstack uses to recognize a container as part of an
 * app/stack. The CLI's `stack list / down / wipe` and `snapshot save`
 * filter by these.
 *
 * Required labels (set them via {@link devstackContainerLabels}):
 *   - `devstack.app=<appName>`     — what the supervisor reads from
 *     `DevstackConfig.app`.
 *   - `devstack.stack=<stack>`     — `'main'` or whatever `--stack` resolved
 *     to.
 *   - `devstack.kind=<service>`    — your container's logical role
 *     (e.g. `'mongo'`).
 *
 * Optional snapshot labels (set on Service actions; the
 * `containerService` action factory reads `snapshot:` and stamps these
 * automatically):
 *   - `devstack.snapshot.commit=true|false`
 *   - `devstack.snapshot.quiesce=pause|stop|none`
 *
 * Optional reconciler label (set automatically; plugin authors don't
 * need to stamp it directly):
 *   - `devstack.input-hash=<hash>` — what `containerService` compares
 *     against to decide whether to reuse vs recreate the container.
 */
interface DevstackContainerLabelOpts {
	appName: string;
	stack: string;
	service: string;
	/** Snapshot capture metadata serialized into `devstack.snapshot.*`
	 * labels. Read by the snapshot orchestrator (`runtime/snapshot.ts`)
	 * to decide per-container whether to `docker commit` and how to
	 * quiesce. Absent → orchestrator falls back to defaults
	 * (commit:true, quiesce:'stop' for Service-typed actions). */
	snapshot?: {
		commit?: boolean;
		quiesce?: 'pause' | 'stop' | 'none';
	};
}

/** Returns the standard label set for a devstack-managed container.
 * Combines our internal `devstack.*` filters with `com.docker.compose.*`
 * labels so Docker Desktop groups all containers for a given app+stack
 * under a single project pane (instead of showing a flat list). The
 * "project" maps to `<appName>-<stack>`; the "service" identifies the
 * individual container within that project. */
export function devstackContainerLabels(opts: DevstackContainerLabelOpts): Record<string, string> {
	const project = `${opts.appName}-${opts.stack}`;
	const labels: Record<string, string> = {
		'devstack.app': opts.appName,
		'devstack.stack': opts.stack,
		'devstack.kind': opts.service,
		'com.docker.compose.project': project,
		'com.docker.compose.service': opts.service,
		// Required for Docker Desktop to recognize the container as part
		// of a compose project (otherwise it treats the project label as
		// arbitrary metadata and still shows the container ungrouped).
		'com.docker.compose.oneoff': 'False',
		'com.docker.compose.version': '2.0.0',
	};
	if (opts.snapshot?.commit !== undefined) {
		labels['devstack.snapshot.commit'] = String(opts.snapshot.commit);
	}
	if (opts.snapshot?.quiesce !== undefined) {
		labels['devstack.snapshot.quiesce'] = opts.snapshot.quiesce;
	}
	return labels;
}
