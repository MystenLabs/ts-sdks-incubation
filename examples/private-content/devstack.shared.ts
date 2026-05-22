export const PRIVATE_CONTENT_APP_PORT = 5170;
export const PRIVATE_CONTENT_APP_ORIGIN = `http://127.0.0.1:${PRIVATE_CONTENT_APP_PORT}` as const;
export const PRIVATE_CONTENT_LOCALHOST_ORIGIN =
	`http://localhost:${PRIVATE_CONTENT_APP_PORT}` as const;
export const PRIVATE_CONTENT_ROUTER_ORIGIN =
	'http://dev.private-content.private-content.localhost:5175' as const;
