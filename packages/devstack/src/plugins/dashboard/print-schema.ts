// SDL printer for the dashboard schema.
//
// The schema is a module-level value (`dashboardSchema`), so printing only
// walks the type system — no deps and no resolver invocation. Writes the SDL
// to `apps/devstack-dashboard/schema.graphql` for the frontend's gql.tada
// typegen. Dependency-free beyond `graphql` + the builder.
//
//   node --experimental-strip-types \
//     packages/devstack/src/plugins/dashboard/print-schema.ts
//
// (or `tsx packages/devstack/src/plugins/dashboard/print-schema.ts`)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printSchema } from 'graphql';
import prettier from 'prettier';
import { dashboardSchema } from './schema.ts';

/** Return the dashboard schema's SDL. */
export const printDashboardSchema = (): string => printSchema(dashboardSchema);

/** Resolve the SDL output path relative to this file. */
const outputPath = (): string =>
	fileURLToPath(new URL('../../../../../apps/devstack-dashboard/schema.graphql', import.meta.url));

/** Write the SDL to the frontend app.
 *
 *  Formats the raw `printSchema()` output with the repo's prettier (graphql
 *  parser) BEFORE writing, so generation and the formatter agree byte-for-byte
 *  — otherwise the committed (prettier-formatted) file and a fresh regeneration
 *  flutter against each other forever (tabs/multi-line docblocks vs the raw
 *  2-space single-line `printSchema` output). */
export const writeDashboardSchema = async (): Promise<string> => {
	const sdl = printDashboardSchema();
	const target = outputPath();
	// Resolve the repo's prettier config for the target path (tabs, print
	// width, …) so the formatted output matches `prettier -c` exactly —
	// `filepath` alone selects the parser but does NOT pick up `.prettierrc`.
	const config = await prettier.resolveConfig(target);
	const formatted = await prettier.format(sdl, {
		...config,
		parser: 'graphql',
		filepath: target,
	});
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, formatted, 'utf8');
	return target;
};

const isMain = (): boolean => {
	const entry = process.argv[1];
	return entry != null && import.meta.url === new URL(`file://${entry}`).href;
};

if (isMain()) {
	const target = await writeDashboardSchema();
	// eslint-disable-next-line no-console
	console.log(`wrote dashboard SDL → ${target}`);
}
