// Sui transport invariant.
//
// Production code that reaches a Sui node must use @mysten/sui's gRPC
// clients/core surface. Raw JSON-RPC calls are deprecated upstream and
// sui-fork does not serve JSON-RPC at all.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');

const collectSourceFiles = (dir: string, acc: Array<string> = []): Array<string> => {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			collectSourceFiles(full, acc);
			continue;
		}
		if (stat.isFile() && entry.endsWith('.ts')) acc.push(full);
	}
	return acc;
};

const stripComments = (source: string): string =>
	source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

describe('Sui transport invariants', () => {
	it('production code does not hand-roll Sui JSON-RPC requests', () => {
		const offenders: Array<{ readonly file: string; readonly match: string }> = [];

		for (const file of collectSourceFiles(SRC_ROOT)) {
			const body = stripComments(readFileSync(file, 'utf8'));
			const patterns = [
				{ label: 'jsonrpc', regex: /\bjsonrpc\b/i },
				{
					label: 'sui JSON-RPC method',
					regex: /\bmethod\s*:\s*['"](?:sui|suix)_[A-Za-z0-9_]+['"]/,
				},
			];
			const matched = patterns.filter((pattern) => pattern.regex.test(body));
			for (const pattern of matched) {
				offenders.push({
					file: relative(resolve(import.meta.dirname, '../..'), file).replaceAll('\\', '/'),
					match: pattern.label,
				});
			}
		}

		expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
	});
});
