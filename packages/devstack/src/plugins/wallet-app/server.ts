// HTTP signer endpoint backing the dev-wallet `DevstackSignerAdapter`.
// Exposes a fixed set of named Signers so a browser-side adapter can
// list addresses and request transaction signatures without ever
// loading private keys into JavaScript.
//
// Endpoints (all under `/api/v1/devstack`):
//   GET  /accounts               → { accounts: [{ name, address, scheme, publicKey }] }
//   POST /sign-transaction       → { suiSignature, txBytes }
//   POST /sign-personal-message  → { signature, bytes }
//
// Plus an unauthenticated `GET /health` for liveness probes.
//
// Localnet-only defaults:
//   - Binds 127.0.0.1, not 0.0.0.0. A LAN attacker who somehow learned
//     the bearer token can't reach the listener.
//   - CORS is restricted to an explicit allowlist (`'*'` is rejected).
//   - A 256-bit random bearer token gates every endpoint; the
//     `?token=…` query form is supported for the adapter's pair URL.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Signer } from '@mysten/sui/cryptography';
import { fromBase64, isValidSuiAddress, toBase64 } from '@mysten/sui/utils';

export interface SignerEntry {
	name: string;
	signer: Signer;
}

export interface WalletServerOptions {
	port: number;
	signers: SignerEntry[];
	/** Bearer token. Generated if not supplied; surfaced via the returned
	 * handle so the plugin can persist + log it. */
	token?: string;
	/** Allowed CORS origins. `'*'` is rejected — bearer tokens leak through
	 * manifests baked into the dev bundle, so any-origin policies compound
	 * the leak. */
	allowedOrigins?: string[];
	/** Bind address. Default `127.0.0.1`. Override only for genuinely-remote
	 * dev rigs that knowingly accept LAN exposure. */
	host?: string;
	/** Max request body size in bytes. Default 2 MB. */
	maxBodyBytes?: number;
}

export interface WalletServerHandle {
	server: Server;
	url: string;
	token: string;
}

interface AccountInfo {
	name: string;
	address: string;
	scheme: string;
	publicKey: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Mint a fresh 256-bit bearer token. */
export function generateToken(): string {
	return randomBytes(32).toString('hex');
}

function buildAccountSnapshot(entries: readonly SignerEntry[]): {
	infos: AccountInfo[];
	signersByAddress: Map<string, Signer>;
} {
	const infos: AccountInfo[] = [];
	const signersByAddress = new Map<string, Signer>();
	for (const { name, signer } of entries) {
		const address = signer.toSuiAddress();
		signersByAddress.set(address, signer);
		infos.push({
			name,
			address,
			scheme: signer.getKeyScheme(),
			publicKey: signer.getPublicKey().toBase64(),
		});
	}
	return { infos, signersByAddress };
}

export async function startWalletServer(opts: WalletServerOptions): Promise<WalletServerHandle> {
	const token = opts.token ?? generateToken();
	const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const host = opts.host ?? DEFAULT_HOST;
	const allowedOrigins = sanitizeAllowedOrigins(opts.allowedOrigins ?? []);
	const snapshot = buildAccountSnapshot(opts.signers);

	const server = createServer(async (req, res) => {
		const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
		applyCorsHeaders(res, origin, allowedOrigins);
		if (req.method === 'OPTIONS') {
			if (origin !== undefined && !originAllowed(origin, allowedOrigins)) {
				res.statusCode = 403;
				res.end();
				return;
			}
			res.statusCode = 204;
			res.end();
			return;
		}
		try {
			const url = new URL(req.url ?? '/', `http://${host}:${opts.port}`);
			if (req.method === 'GET' && url.pathname === '/health') {
				return sendJson(res, 200, { ok: true });
			}
			// Belt-and-suspenders server-side check against a same-machine
			// attacker who skipped the CORS preflight.
			if (origin !== undefined && !originAllowed(origin, allowedOrigins)) {
				return sendJson(res, 403, { error: `Origin ${origin} not allowed` });
			}
			if (!isAuthorized(req, token)) {
				return sendJson(res, 401, {
					error: 'Authentication required. Pair via the URL printed at startup.',
				});
			}
			if (req.method === 'GET' && url.pathname === '/api/v1/devstack/accounts') {
				return sendJson(res, 200, { accounts: snapshot.infos });
			}
			if (req.method === 'POST' && url.pathname === '/api/v1/devstack/sign-transaction') {
				return await handleSignTransaction(req, res, snapshot.signersByAddress, maxBodyBytes);
			}
			if (req.method === 'POST' && url.pathname === '/api/v1/devstack/sign-personal-message') {
				return await handleSignPersonalMessage(
					req,
					res,
					snapshot.signersByAddress,
					maxBodyBytes,
				);
			}
			sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, 500, { error: `Internal error: ${message}` });
		}
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			server.off('listening', onListening);
			reject(err);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(opts.port, host);
	});
	const addr = server.address();
	const resolvedPort =
		typeof addr === 'object' && addr !== null && 'port' in addr ? addr.port : opts.port;
	const url = `http://${displayHost(host)}:${resolvedPort}`;
	return { server, url, token };
}

function sanitizeAllowedOrigins(input: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of input) {
		if (raw === '*') {
			throw new Error(
				'wallet-app: allowedOrigins cannot include "*" — bearer tokens leak through ' +
					'manifests baked into the dev bundle, so any-origin policies compound the leak. ' +
					'Pass the dev-server origin (e.g. "http://localhost:5173") explicitly.',
			);
		}
		try {
			out.push(new URL(raw).origin);
		} catch {
			throw new Error(`wallet-app: invalid origin in allowedOrigins: ${raw}`);
		}
	}
	return out;
}

function originAllowed(origin: string, allowed: readonly string[]): boolean {
	if (allowed.length === 0) return false;
	return allowed.includes(origin);
}

function applyCorsHeaders(
	res: ServerResponse,
	origin: string | undefined,
	allowed: readonly string[],
): void {
	res.setHeader('Vary', 'Origin');
	if (origin !== undefined && originAllowed(origin, allowed)) {
		res.setHeader('Access-Control-Allow-Origin', origin);
	}
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	res.setHeader('Access-Control-Max-Age', '86400');
}

function displayHost(host: string): string {
	if (host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === '::1') {
		return 'localhost';
	}
	return host;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
	const header = req.headers.authorization;
	if (typeof header === 'string' && /^bearer /i.test(header)) {
		return safeEqualHex(header.slice(7), token);
	}
	const url = new URL(req.url ?? '/', `http://localhost`);
	const queryToken = url.searchParams.get('token');
	if (queryToken === null) return false;
	return safeEqualHex(queryToken, token);
}

function safeEqualHex(provided: string, expected: string): boolean {
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function readJsonBody(
	req: IncomingMessage,
	maxBodyBytes: number,
): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > maxBodyBytes) {
			throw new RequestError(413, 'Request body too large');
		}
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== 'object') {
			throw new RequestError(400, 'Body must be a JSON object');
		}
		return parsed as Record<string, unknown>;
	} catch (err) {
		if (err instanceof RequestError) throw err;
		throw new RequestError(400, 'Invalid JSON body');
	}
}

async function handleSignTransaction(
	req: IncomingMessage,
	res: ServerResponse,
	signers: Map<string, Signer>,
	maxBodyBytes: number,
): Promise<void> {
	let body: Record<string, unknown>;
	try {
		body = await readJsonBody(req, maxBodyBytes);
	} catch (err) {
		if (err instanceof RequestError) return sendJson(res, err.status, { error: err.message });
		throw err;
	}
	const address = body['address'];
	const txBytes = body['txBytes'];
	if (typeof address !== 'string' || !isValidSuiAddress(address)) {
		return sendJson(res, 400, { error: 'Invalid address; expected 0x-prefixed hex' });
	}
	if (typeof txBytes !== 'string' || txBytes.length === 0) {
		return sendJson(res, 400, { error: 'Invalid txBytes; expected non-empty base64 string' });
	}
	const signer = signers.get(address);
	if (signer === undefined) {
		return sendJson(res, 404, { error: `No signer for address ${address}` });
	}
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(txBytes);
	} catch {
		return sendJson(res, 400, { error: 'txBytes is not valid base64' });
	}
	const { signature } = await signer.signTransaction(bytes);
	sendJson(res, 200, { suiSignature: signature, txBytes: toBase64(bytes) });
}

async function handleSignPersonalMessage(
	req: IncomingMessage,
	res: ServerResponse,
	signers: Map<string, Signer>,
	maxBodyBytes: number,
): Promise<void> {
	let body: Record<string, unknown>;
	try {
		body = await readJsonBody(req, maxBodyBytes);
	} catch (err) {
		if (err instanceof RequestError) return sendJson(res, err.status, { error: err.message });
		throw err;
	}
	const address = body['address'];
	const messageBytes = body['messageBytes'];
	if (typeof address !== 'string' || !isValidSuiAddress(address)) {
		return sendJson(res, 400, { error: 'Invalid address; expected 0x-prefixed hex' });
	}
	if (typeof messageBytes !== 'string' || messageBytes.length === 0) {
		return sendJson(res, 400, {
			error: 'Invalid messageBytes; expected non-empty base64 string',
		});
	}
	const signer = signers.get(address);
	if (signer === undefined) {
		return sendJson(res, 404, { error: `No signer for address ${address}` });
	}
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(messageBytes);
	} catch {
		return sendJson(res, 400, { error: 'messageBytes is not valid base64' });
	}
	const { signature } = await signer.signPersonalMessage(bytes);
	sendJson(res, 200, { signature, bytes: toBase64(bytes) });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(body));
}
