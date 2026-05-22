import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	COMMAND_TREE,
	type CommandNode,
	type CommandOption,
} from '../../../src/surfaces/cli/command-tree.ts';

const CLI_REFERENCE = fileURLToPath(
	new URL('../../../../docs/content/devstack/reference/cli.mdx', import.meta.url),
);

const formatOption = (option: CommandOption): string =>
	`--${option.name}${option.value ? ` <${option.value}>` : ''}`;

const commandNodes = (
	node: CommandNode,
): ReadonlyArray<{ readonly path: string; readonly node: CommandNode }> => {
	const out: Array<{ path: string; node: CommandNode }> = [];
	for (const child of node.subcommands ?? []) {
		out.push({ path: child.name, node: child });
		for (const nested of commandNodes(child)) {
			out.push({ path: `${child.name} ${nested.path}`, node: nested.node });
		}
	}
	return out;
};

const sectionForUsage = (doc: string, usage: string): string => {
	const heading = `### \`${usage}\``;
	const start = doc.indexOf(heading);
	if (start === -1) return '';
	const rest = doc.slice(start + heading.length);
	const next = rest.search(/\n#{2,3} /);
	return next === -1 ? rest : rest.slice(0, next);
};

const METADATA_LABELS = ['Lifecycle', 'Side effects', 'Docker', 'Arguments', 'Options'] as const;

const parseInlineCodeList = (section: string, label: string): ReadonlyArray<string> => {
	const body = section
		.split('\n')
		.map((value) => value.trim())
		.join(' ');
	const start = body.indexOf(`${label}: `);
	if (start === -1) return [];
	const valueStart = start + `${label}: `.length;
	let valueEnd = body.length;
	for (const metadataLabel of METADATA_LABELS) {
		if (metadataLabel === label) continue;
		const marker = ` ${metadataLabel}: `;
		const index = body.indexOf(marker, valueStart);
		if (index !== -1) {
			valueEnd = Math.min(valueEnd, index);
		}
	}
	const value = body.slice(valueStart, valueEnd).trim();
	const values = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
	return values.length > 0 ? values : value === 'none.' ? [] : [];
};

describe('CLI reference docs', () => {
	const doc = readFileSync(CLI_REFERENCE, 'utf8');

	it('documents every public command from COMMAND_TREE', () => {
		for (const { path, node } of commandNodes(COMMAND_TREE)) {
			const section = sectionForUsage(doc, node.usage);
			expect(section, `missing heading for '${path}' usage '${node.usage}'`).not.toBe('');
			expect(section, `missing summary for '${path}'`).toContain(node.summary);
			expect(section, `missing lifecycle for '${path}'`).toContain(`Lifecycle: ${node.lifecycle}`);
			expect(section, `missing side effect for '${path}'`).toContain(
				`Side effects: ${node.sideEffects}`,
			);
			expect(section, `missing Docker requirement for '${path}'`).toContain(
				`Docker: ${node.requiresDocker ? 'yes' : 'no'}`,
			);
		}
	});

	it('documents command arguments and command-scoped options', () => {
		for (const { path, node } of commandNodes(COMMAND_TREE)) {
			const section = sectionForUsage(doc, node.usage);
			expect(parseInlineCodeList(section, 'Arguments'), `arguments for '${path}'`).toEqual(
				node.arguments ?? [],
			);
			expect(parseInlineCodeList(section, 'Options'), `options for '${path}'`).toEqual(
				(node.options ?? []).map(formatOption),
			);
		}
	});
});
