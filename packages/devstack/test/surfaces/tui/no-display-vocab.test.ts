// The "no display vocab" invariant — grepped at test time.
//
// Architecture: the projection must NEVER carry `title`/`primary`/
// `extras`, and the renderer must NEVER consume such fields. The
// substrate enforces the projection side via `__ProjectionFieldsClosed`
// (compile-time). This test enforces the renderer side: a regex
// sweep of every TUI surface file looking for forbidden literal
// strings.
//
// We test for source-code occurrences of the forbidden words, NOT
// runtime behavior — the words are the leak signal. If a renderer
// starts reading `row.title` (or anything similar), this test fails.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SURFACE_DIR = fileURLToPath(new URL('../../../src/surfaces/tui/', import.meta.url));

const collectSourceFiles = (dir: string): Array<string> => {
	const out: Array<string> = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (/\.(tsx?|ts)$/.test(entry)) {
			out.push(full);
		}
	}
	return out;
};

const FORBIDDEN_FIELDS = [
	// Field-access patterns: `row.title`, `state.title`, `r.title`, …
	/\b(?:row|r|state|s|entry|cell|row_)\.(?:title|primary|extras)\b/i,
] as const;

const COMMENT_EXEMPTION = /(?:NEVER|NOT|forbidden|MUST NOT|absent)/i;

describe('TUI surface — no display-vocab consumption', () => {
	const files = collectSourceFiles(SURFACE_DIR);
	it.each(files)('%s does not read row.title / row.primary / row.extras', (file) => {
		const content = readFileSync(file, 'utf8');
		// Walk line-by-line so we can exempt comment lines that
		// MENTION the forbidden words (e.g. "NEVER reads row.title").
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			for (const pattern of FORBIDDEN_FIELDS) {
				if (pattern.test(line)) {
					// Look at this line and the previous line for a
					// negation comment that explains the mention.
					const prev = i > 0 ? lines[i - 1]! : '';
					const isComment =
						line.trimStart().startsWith('//') ||
						line.trimStart().startsWith('*') ||
						prev.trimStart().startsWith('//') ||
						prev.trimStart().startsWith('*');
					const explainsAbsence = COMMENT_EXEMPTION.test(line) || COMMENT_EXEMPTION.test(prev);
					if (isComment && explainsAbsence) continue;
					throw new Error(`Forbidden display-vocab access at ${file}:${i + 1} — ${line.trim()}`);
				}
			}
		}
		expect(true).toBe(true);
	});
});
