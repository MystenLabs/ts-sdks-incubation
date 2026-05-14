// Rewrite a `http://localhost:PORT/...` or `http://127.0.0.1:PORT/...`
// URL so it points at the container-visible host gateway instead.
// Containers can't reach `127.0.0.1` (that's themselves) — `Docker.run`
// wires `host.docker.internal:host-gateway` for us, so this works on
// both Docker Desktop and Linux. The path/query are preserved as-is.

export const HOST_GATEWAY = 'host.docker.internal';

export const rewriteToHostGateway = (url: string): string => {
	try {
		const u = new URL(url);
		if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
			u.hostname = HOST_GATEWAY;
			return u.toString();
		}
		return url;
	} catch {
		return url;
	}
};
