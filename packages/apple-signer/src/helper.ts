// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { resolveBinaryPath } from './binary-resolver.js';

/**
 * Abstract protocol the Swift helper exposes. Each request is a JSON line with
 * an `id`, `op`, and op-specific args; each response has the same `id` and
 * either `ok: true, data: ...` or `ok: false, error: ...`.
 *
 * The built-in {@link SubprocessHelper} spawns the compiled Swift binary and
 * speaks this protocol over stdio. Tests can provide a mock by implementing
 * {@link AppleHelper} directly.
 */
export interface AppleHelper {
	request<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
	close(): Promise<void>;
	/**
	 * Register a callback that fires once when the helper exits (whether via
	 * `close()`, subprocess crash, or parent teardown). Used by the default-
	 * helper cache to self-heal after the subprocess dies.
	 */
	onExit(cb: () => void): void;
}

export interface SubprocessHelperOptions {
	/** Override the path to the compiled Swift binary. Default: auto-resolved. */
	binaryPath?: string;
}

interface Response {
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
	/**
	 * Machine-readable error code when `ok: false`. Known values:
	 * `not_found`, `already_exists`, `auth_failed`, `user_canceled`,
	 * `missing_entitlement`, `unknown`. Absent for ad-hoc error messages
	 * the helper doesn't classify.
	 */
	code?: string;
}

/**
 * Error thrown by `SubprocessHelper.request` when the helper returns `ok: false`.
 * Carries the machine-readable `code` (when the helper classified the error) and
 * the raw message from Swift.
 */
export class HelperError extends Error {
	readonly code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.name = 'HelperError';
		this.code = code;
	}
}

/**
 * Default {@link AppleHelper} that spawns the Swift helper binary and
 * communicates over stdio with JSON-Lines. The binary is long-lived for the
 * lifetime of the Node process — its single LAContext stays authorized after
 * the first biometric prompt, so subsequent signs are silent.
 */
export class SubprocessHelper implements AppleHelper {
	#proc: ChildProcessWithoutNullStreams;
	#buffer = '';
	#pending = new Map<string, (res: Response) => void>();
	#nextId = 1;
	#closed = false;
	#exitCallbacks: Array<() => void> = [];

	static async load(options: SubprocessHelperOptions = {}): Promise<SubprocessHelper> {
		const binaryPath = options.binaryPath ?? (await resolveBinaryPath());
		return new SubprocessHelper(binaryPath);
	}

	constructor(binaryPath: string) {
		this.#proc = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
		this.#proc.stdout.setEncoding('utf8');
		this.#proc.stderr.setEncoding('utf8');
		this.#proc.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
		this.#proc.on('exit', () => this.#onExit());
		this.#proc.on('error', (err) => this.#onExit(err));
	}

	async request<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
		if (this.#closed) {
			throw new Error('apple-signer: helper is closed');
		}
		const id = `req-${this.#nextId++}`;
		const payload = JSON.stringify({ id, op, ...args }) + '\n';
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, (res) => {
				if (res.ok) resolve(res.data as T);
				else reject(new HelperError(res.error ?? 'apple-signer: unknown error', res.code));
			});
			if (!this.#proc.stdin.write(payload)) {
				this.#proc.stdin.once('drain', () => {});
			}
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#proc.stdin.end();
		} catch {
			// proc may already be dead
		}
		if (this.#proc.exitCode === null && this.#proc.signalCode === null) {
			await new Promise<void>((resolve) => {
				const t = setTimeout(() => {
					this.#proc.kill();
					resolve();
				}, 500);
				this.#proc.once('exit', () => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}

	#onStdout(chunk: string): void {
		this.#buffer += chunk;
		let idx: number;
		while ((idx = this.#buffer.indexOf('\n')) >= 0) {
			const line = this.#buffer.slice(0, idx);
			this.#buffer = this.#buffer.slice(idx + 1);
			if (!line.trim()) continue;
			try {
				const res = JSON.parse(line) as Response;
				const cb = this.#pending.get(res.id);
				if (cb) {
					this.#pending.delete(res.id);
					cb(res);
				}
			} catch {
				// malformed line — ignore
			}
		}
	}

	onExit(cb: () => void): void {
		if (this.#closed) {
			queueMicrotask(cb);
			return;
		}
		this.#exitCallbacks.push(cb);
	}

	#onExit(err?: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		const reason = err ?? new Error('apple-signer: helper exited');
		for (const [id, cb] of this.#pending) {
			cb({ id, ok: false, error: reason.message });
		}
		this.#pending.clear();
		for (const cb of this.#exitCallbacks) {
			try {
				cb();
			} catch {
				// user callback errors shouldn't break the others
			}
		}
		this.#exitCallbacks = [];
	}
}
