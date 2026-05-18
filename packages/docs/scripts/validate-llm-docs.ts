// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate LLM documentation quality.
 * Checks that all MDX files have title and description frontmatter,
 * and that all MDX files are referenced in their parent meta.json.
 */

import * as path from 'node:path';

import { findMdxFiles, readMetaJson, readMdxFrontmatter } from './docs-utils.js';

const CONTENT_DIR = path.resolve(new URL('.', import.meta.url).pathname, '..', 'content');

let errors = 0;
let warnings = 0;

const mdxFiles = findMdxFiles(CONTENT_DIR);

for (const mdxFile of mdxFiles) {
	const rel = path.relative(CONTENT_DIR, mdxFile);
	const fm = readMdxFrontmatter(mdxFile);

	if (!fm.title) {
		console.error(`ERROR: ${rel} — missing "title" in frontmatter`);
		errors++;
	}

	if (!fm.description) {
		console.warn(`WARN:  ${rel} — missing "description" in frontmatter`);
		warnings++;
	}

	// Check if file is referenced in parent meta.json
	const dir = path.dirname(mdxFile);
	const meta = readMetaJson(dir);
	if (meta?.pages) {
		const baseName = path.basename(mdxFile, '.mdx');
		if (baseName !== 'index' && !meta.pages.includes(baseName) && !meta.pages.includes('...')) {
			console.error(`ERROR: ${rel} — not listed in ${path.relative(CONTENT_DIR, dir)}/meta.json`);
			errors++;
		}
	}
}

console.log(`\nValidation: ${mdxFiles.length} files, ${errors} errors, ${warnings} warnings`);
if (errors > 0) {
	process.exit(1);
}
