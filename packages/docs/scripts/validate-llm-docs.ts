// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate LLM documentation quality.
 * Checks that all MDX files have title and description frontmatter,
 * that all MDX files are referenced in their parent meta.json,
 * and that internal links resolve to existing files or anchors.
 */

import * as fs from 'node:fs';
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

// Check internal links.
const allPages = new Set<string>();
const pageAnchors = new Map<string, Set<string>>();

function slugifyHeading(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function extractHeadingAnchors(content: string): Set<string> {
	const anchors = new Set<string>();
	const lines = content.split('\n');
	let inCodeBlock = false;

	for (const line of lines) {
		if (line.trimStart().startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (inCodeBlock) continue;

		const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
		if (headingMatch) {
			anchors.add(slugifyHeading(headingMatch[1]));
		}
	}

	return anchors;
}

for (const mdxFile of mdxFiles) {
	const rel = path.relative(CONTENT_DIR, mdxFile).replace(/\.mdx$/, '');
	const anchors = extractHeadingAnchors(fs.readFileSync(mdxFile, 'utf-8'));

	if (rel.endsWith('/index')) {
		const dirPath = rel.replace(/\/index$/, '');
		allPages.add(dirPath);
		pageAnchors.set(dirPath, anchors);
	}

	allPages.add(rel);
	pageAnchors.set(rel, anchors);
}

function extractLinks(content: string): { target: string; line: number }[] {
	const links: { target: string; line: number }[] = [];
	const lines = content.split('\n');
	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trimStart().startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (inCodeBlock) continue;

		const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
		let match: RegExpExecArray | null;
		while ((match = linkRegex.exec(lines[i])) !== null) {
			links.push({ target: match[2], line: i + 1 });
		}
	}

	return links;
}

function resolveLink(
	target: string,
	fileDir: string,
): { resolvedRel: string; anchor: string | null } | null {
	const [linkPath, anchor] = target.split('#');

	if (!linkPath) return null;

	const resolved = linkPath.startsWith('/')
		? path.resolve(CONTENT_DIR, linkPath.slice(1))
		: path.resolve(fileDir, linkPath);

	return { resolvedRel: path.relative(CONTENT_DIR, resolved), anchor: anchor ?? null };
}

for (const mdxFile of mdxFiles) {
	const content = fs.readFileSync(mdxFile, 'utf-8');
	const rel = path.relative(CONTENT_DIR, mdxFile);
	const fileDir = path.dirname(mdxFile);
	const pageRel = rel.replace(/\.mdx$/, '');
	const selfAnchors = pageAnchors.get(pageRel);

	for (const { target, line } of extractLinks(content)) {
		if (
			target.startsWith('http://') ||
			target.startsWith('https://') ||
			target.startsWith('mailto:') ||
			target.startsWith('/typedoc/')
		) {
			continue;
		}

		if (target.startsWith('#')) {
			const anchor = target.slice(1);
			if (selfAnchors && !selfAnchors.has(anchor)) {
				console.error(`ERROR: ${rel}:${line} — broken anchor "${target}"`);
				errors++;
			}
			continue;
		}

		const isIndexPage = path.basename(mdxFile, '.mdx') === 'index';
		if (isIndexPage && !target.startsWith('/')) {
			console.error(
				`ERROR: ${rel}:${line} — relative link "${target}" in index page will break at runtime; use an absolute path`,
			);
			errors++;
			continue;
		}

		const resolved = resolveLink(target, fileDir);
		if (!resolved) continue;

		const { resolvedRel, anchor } = resolved;
		const pageExists =
			allPages.has(resolvedRel) ||
			fs.existsSync(path.resolve(CONTENT_DIR, resolvedRel)) ||
			fs.existsSync(path.resolve(CONTENT_DIR, `${resolvedRel}.mdx`)) ||
			fs.existsSync(path.resolve(CONTENT_DIR, resolvedRel, 'index.mdx')) ||
			fs.existsSync(path.resolve(CONTENT_DIR, resolvedRel, 'meta.json'));

		if (!pageExists) {
			console.error(`ERROR: ${rel}:${line} — broken link to "${target}"`);
			errors++;
			continue;
		}

		if (anchor) {
			const targetAnchors = pageAnchors.get(resolvedRel);
			if (targetAnchors && !targetAnchors.has(anchor)) {
				console.error(
					`ERROR: ${rel}:${line} — broken anchor "${target}" (page exists but heading does not)`,
				);
				errors++;
			}
		}
	}
}

// Reverse sweep: every `meta.json:pages` entry must resolve to a real file
// or directory. Catches stale meta.json entries that point at deleted pages
// or typos that the forward walk would not detect (forward walk only checks
// that present MDX files are listed; it does not check that listed pages
// are present).
function walkMetaDirs(dir: string): void {
	const meta = readMetaJson(dir);
	if (meta?.pages) {
		for (const entry of meta.pages) {
			if (entry === '...') continue;
			const mdxFile = path.join(dir, `${entry}.mdx`);
			const indexFile = path.join(dir, entry, 'index.mdx');
			const subMeta = path.join(dir, entry, 'meta.json');
			const resolved =
				fs.existsSync(mdxFile) || fs.existsSync(indexFile) || fs.existsSync(subMeta);
			if (!resolved) {
				const relDir = path.relative(CONTENT_DIR, dir) || '.';
				console.error(
					`ERROR: ${relDir}/meta.json — unresolved page "${entry}" (expected ${entry}.mdx, ${entry}/index.mdx, or ${entry}/meta.json)`,
				);
				errors++;
			}
		}
	}

	for (const subEntry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (subEntry.isDirectory()) {
			walkMetaDirs(path.join(dir, subEntry.name));
		}
	}
}

walkMetaDirs(CONTENT_DIR);

console.log(`\nValidation: ${mdxFiles.length} files, ${errors} errors, ${warnings} warnings`);
if (errors > 0) {
	process.exit(1);
}
