// Host UID:GID accessor for bind-mount ownership.
//
// When the substrate runs a container with a host bind mount, the
// container's writes land on the host filesystem as the container's
// effective UID. On native Linux Docker that defaults to root, which
// makes the resulting files un-deletable from the developer's shell
// without `sudo`. Plugins thread `${UID}:${GID}` into the container's
// `--user` flag (or via `DEVSTACK_HOST_UID_GID` for entrypoints that
// re-exec) so the writes land owned by the invoking user.
//
// Returns `undefined` on platforms where `process.getuid/getgid` are
// not available (Windows, browser). Callers omit the user/env stamp in
// that case — Docker Desktop handles the ownership mapping itself.

export const hostBindMountOwner = (): string | undefined => {
	const process = (
		globalThis as {
			process?: { getuid?: () => number; getgid?: () => number };
		}
	).process;
	if (typeof process?.getuid !== 'function' || typeof process.getgid !== 'function') {
		return undefined;
	}
	return `${process.getuid()}:${process.getgid()}`;
};
