// Shared filesystem lock primitive — wx-mode write + stale-PID reclaim.
// Three subsystems hold rendezvous locks today:
//
//   - `engine/port-allocator.ts` — host-wide `<port>.lock` so two
//     supervisors don't both probe the same OS-free port and race for
//     the vite/wallet bind.
//   - `engine/state-store.ts` — per-stack `<stack>/state.json.lock` so
//     two `devstack up` invocations against the same stack can't both
//     mutate the state map (Effect-platform variant; retains its
//     jittered-backoff retry loop — see file).
//   - `engine/sui-fork/file-lock.ts` — per-data-dir lock for sui-fork
//     since sui-fork has no built-in single-writer guard on its
//     RocksDB data dir.
//
// All three share: lock body shape (`{pid, startedAt, host}` + optional
// `instanceId` for ownership-after-reclaim), O_EXCL create, stale-PID
// recovery via `process-liveness.ts`, finalizer-based release.
//
// This module exposes the shared body codec + a sync `tryClaim` so the
// sync callers (port-allocator, sui-fork) can stop duplicating
// serialize / parse / unlink-and-retry. The state-store path stays on
// Effect-platform FS for the retry loop's `Effect.sleep` jitter — its
// retry semantics aren't a fit for sync `fs`, so it composes
// `parseLockBody` only.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { isHolderLive, processStartTime, type LockHolder } from './process-liveness.js';

/** Lock body. Optional fields: `instanceId` for reclaim-race protection
 *  (state-store + sui-fork carry it; port-allocator doesn't);
 *  `acquiredAt` for the state-store's "when did this lock land?" stamp
 *  in error reporting. */
export interface LockBody extends LockHolder {
	readonly instanceId?: string;
	readonly acquiredAt?: string;
}

/** Compute the running process's lock body. `instanceId` is freshly
 *  generated per call so two concurrent reclaimers on the same pid can
 *  prove ownership independently. */
export const ownLockBody = (opts?: { withInstanceId?: boolean; withAcquiredAt?: boolean }): LockBody => {
	const base: LockBody = {
		pid: process.pid,
		startedAt: processStartTime(process.pid) ?? '',
		host: hostname(),
	};
	let body = base;
	if (opts?.withInstanceId !== false) {
		body = { ...body, instanceId: randomUUID() };
	}
	if (opts?.withAcquiredAt) {
		body = { ...body, acquiredAt: new Date().toISOString() };
	}
	return body;
};

/** Serialize a lock body to disk form. Stable key order so two writers
 *  produce byte-identical bodies. */
export const serializeLockBody = (body: LockBody): string => {
	const out: Record<string, unknown> = {
		pid: body.pid,
		startedAt: body.startedAt,
		host: body.host,
	};
	if (body.instanceId !== undefined) out.instanceId = body.instanceId;
	if (body.acquiredAt !== undefined) out.acquiredAt = body.acquiredAt;
	return JSON.stringify(out);
};

/** Parse a lock body from disk. Returns `undefined` for malformed
 *  payloads (including the pre-Theme-6c bare-pid format port-allocator
 *  used to write); callers treat that as "reclaim the slot, the
 *  previous writer used an obsolete schema." */
export const parseLockBody = (raw: string): LockBody | undefined => {
	try {
		const obj = JSON.parse(raw.trim()) as Partial<LockBody>;
		if (
			obj === null ||
			typeof obj !== 'object' ||
			typeof obj.pid !== 'number' ||
			!Number.isFinite(obj.pid) ||
			obj.pid <= 0 ||
			typeof obj.startedAt !== 'string' ||
			typeof obj.host !== 'string'
		) {
			return undefined;
		}
		const body: LockBody = { pid: obj.pid, startedAt: obj.startedAt, host: obj.host };
		if (typeof obj.instanceId === 'string') {
			return { ...body, instanceId: obj.instanceId };
		}
		return body;
	} catch {
		return undefined;
	}
};

/** Outcome of a sync claim attempt. `ok: true` — we own the lock and
 *  `body` was just written. `ok: false` — a live holder is in the way
 *  and `holder` describes it; the caller surfaces the body in its
 *  typed-error message. */
export type TryClaimResult =
	| { readonly ok: true; readonly body: LockBody }
	| { readonly ok: false; readonly holder: LockBody | undefined };

/** Sync claim a lock at `lockPath`. Atomic O_EXCL create; on EEXIST,
 *  inspects the on-disk body's PID liveness and either reclaims (unlink
 *  + retry the O_EXCL write) or fails. Synchronous because both
 *  callers (port-allocator, sui-fork) need the result inside a sync
 *  bind-probe loop / typed-error path.
 *
 *  `acquiredAt` is included in the on-disk body when
 *  `opts.withAcquiredAt: true` (state-store-style debug info);
 *  defaults off. */
export const tryClaimLockSync = (
	lockPath: string,
	opts?: { withInstanceId?: boolean; withAcquiredAt?: boolean },
): TryClaimResult => {
	try {
		fs.mkdirSync(dirname(lockPath), { recursive: true });
	} catch {
		// best-effort; the writeFileSync below will surface the real error
	}
	const body = ownLockBody(opts);
	try {
		fs.writeFileSync(lockPath, serializeLockBody(body), { flag: 'wx' });
		return { ok: true, body };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
			return { ok: false, holder: undefined };
		}
	}
	// EEXIST — inspect the existing holder.
	let raw: string;
	try {
		raw = fs.readFileSync(lockPath, 'utf8');
	} catch (err) {
		// ENOENT here means the holder vanished between EEXIST and read
		// — retry the O_EXCL create once. Other errors (EACCES, EIO) we
		// can't prove the slot is free; fail cautiously.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return reclaimSync(lockPath, undefined, opts);
		}
		return { ok: false, holder: undefined };
	}
	const holder = parseLockBody(raw);
	if (holder !== undefined && isHolderLive(holder)) {
		return { ok: false, holder };
	}
	// Stale (dead holder, or unparseable body from the obsolete schema)
	// — reclaim.
	return reclaimSync(lockPath, holder, opts);
};

/** Unlink the (presumed-stale) lock and re-attempt the O_EXCL write.
 *  Internal — call sites go through `tryClaimLockSync`. The race-safety
 *  argument: the unlink is best-effort (ENOENT just means a peer beat
 *  us to it); the subsequent O_EXCL is the canonical "did we win?"
 *  signal — only one writer can win the kernel's create-new-file
 *  race. */
const reclaimSync = (
	lockPath: string,
	priorHolder: LockBody | undefined,
	opts?: { withInstanceId?: boolean; withAcquiredAt?: boolean },
): TryClaimResult => {
	try {
		fs.unlinkSync(lockPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			return { ok: false, holder: priorHolder };
		}
	}
	try {
		const body = ownLockBody(opts);
		fs.writeFileSync(lockPath, serializeLockBody(body), { flag: 'wx' });
		return { ok: true, body };
	} catch {
		return { ok: false, holder: priorHolder };
	}
};

/** Sync release. Only deletes the lock file when its on-disk body
 *  carries the same `instanceId` as `ownBody` — defensive against a
 *  peer reclaimer that detected ours as stale and wrote its own. When
 *  `ownBody.instanceId === undefined`, falls back to `(pid, startedAt,
 *  host)` equality. */
export const releaseLockSync = (lockPath: string, ownBody: LockBody): void => {
	try {
		const raw = fs.readFileSync(lockPath, 'utf8');
		const onDisk = parseLockBody(raw);
		if (onDisk === undefined) return;
		const matchesByInstanceId =
			ownBody.instanceId !== undefined && onDisk.instanceId === ownBody.instanceId;
		const matchesByHolder =
			ownBody.instanceId === undefined &&
			onDisk.pid === ownBody.pid &&
			onDisk.startedAt === ownBody.startedAt &&
			onDisk.host === ownBody.host;
		if (matchesByInstanceId || matchesByHolder) {
			fs.unlinkSync(lockPath);
		}
	} catch {
		// Already released or unreadable; nothing to do.
	}
};
