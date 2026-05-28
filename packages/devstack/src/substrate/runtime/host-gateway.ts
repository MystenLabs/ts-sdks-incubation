// Host-gateway `extraHosts` — ONE canonical constant.
//
// A container that needs to reach a service on the host's loopback
// (e.g. Docker-published ports from a sibling container, or a host
// process bound to `127.0.0.1`) does it by name via
// `host.docker.internal`. Docker Desktop on macOS/Windows wires this
// automatically; native Linux Docker does NOT and requires an
// explicit `--add-host host.docker.internal:host-gateway` per
// container (the literal string `host-gateway` is a Docker token
// that resolves to the gateway IP of the container's network).
//
// This constant is the `extraHosts:` value passed to
// `EnsureContainerSpec` / `runOneShot`. Use it instead of inlining
// `{ 'host.docker.internal': 'host-gateway' }` at every dial-host
// container site so a future change (e.g. additional aliases, or
// platform-conditional mapping) lives in one place.

/** Container `extraHosts` mapping that resolves
 *  `host.docker.internal` to the host gateway on native Linux
 *  Docker. Pass as `extraHosts:` on container specs that need to
 *  dial host-bound services. */
export const HOST_GATEWAY_EXTRA_HOSTS: Readonly<Record<string, string>> = {
	'host.docker.internal': 'host-gateway',
};
