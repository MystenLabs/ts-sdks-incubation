// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Wait `ms`, rejecting with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error('Aborted'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** The result of `work`, or null when it fails or takes longer than `ms`. For lookups nothing may wait on. */
export async function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
	const giveUp = new AbortController();
	const result = await Promise.race([
		work.catch(() => null),
		sleep(ms, giveUp.signal).then(
			() => null,
			() => null,
		),
	]);
	giveUp.abort();
	return result;
}
